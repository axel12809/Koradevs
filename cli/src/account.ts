import fs from 'node:fs';
import pc from 'picocolors';
import { SosRequestSchema, errorSummary, type CreatedRequest, type RadarStage, type SolutionHit, type SosRequest } from '@sos/shared';
import { ApiError, createApi } from './api.js';
import { CliError } from './args.js';
import { readConfig, serverUrl, writeConfig } from './config.js';
import { githubDeviceFlow } from './device-flow.js';
import { saveRequest } from './store.js';
import { openSalle } from './salle.js';
import { waitForHelper } from './wait.js';

export async function login(options: { dev?: string; server?: string }): Promise<number> {
  const config = readConfig();
  const server = options.server ? options.server.replace(/\/+$/, '') : serverUrl(config);
  const api = createApi(server);

  let session;
  if (options.dev) {
    session = await api.loginDev(options.dev);
  } else {
    const auth = await api.authConfig();
    if (!auth.githubClientId) {
      throw new CliError(
        auth.devAuth
          ? 'ce serveur n’a pas de connexion GitHub configurée. Pour tester en local : sos login --dev <pseudo>'
          : 'ce serveur n’a pas de connexion GitHub configurée.',
      );
    }
    const githubToken = await githubDeviceFlow(auth.githubClientId, {
      onCode: ({ userCode, verificationUri }) => {
        console.log(`\nOuvre ${pc.bold(verificationUri)} et saisis le code ${pc.bold(pc.cyan(userCode))}`);
        console.log(pc.dim('En attente de ta validation sur GitHub…'));
      },
    });
    session = await api.loginGithub(githubToken);
  }

  writeConfig({ ...config, ...(options.server ? { server } : {}), token: session.token, login: session.user.login });
  const mode = session.user.provider === 'dev' ? ' (mode démo)' : '';
  console.log(pc.green(`✔ Connecté en tant que ${session.user.login}${mode} sur ${server}.`));
  return 0;
}

export async function logout(): Promise<number> {
  const config = readConfig();
  if (config.token) await createApi(serverUrl(config), config.token).logout().catch(() => undefined);
  const { token: _token, login: _login, ...rest } = config;
  writeConfig(rest);
  console.log('Déconnecté.');
  return 0;
}

export async function whoami(): Promise<number> {
  const config = readConfig();
  if (!config.token) {
    console.log('Pas connecté. Lance « sos login ».');
    return 1;
  }
  const user = await createApi(serverUrl(config), config.token).me();
  console.log(`${user.login}${user.provider === 'dev' ? ' (mode démo)' : ''} sur ${serverUrl(config)}`);
  return 0;
}

/** Looks for published sheets matching the (already masked) error. Silent if the server is unreachable. */
export async function findSolutions(request: SosRequest): Promise<SolutionHit[]> {
  const query = errorSummary(request.output);
  if (!query) return [];
  try {
    return await createApi(serverUrl()).searchSolutions(query, request.tech);
  } catch {
    return [];
  }
}

export function renderSolutions(hits: SolutionHit[]): string {
  const lines = [pc.bold('\nDes fiches ressemblent à ton erreur :')];
  hits.forEach((hit, i) => {
    lines.push(`  ${i + 1}. ${pc.bold(hit.title)} ${pc.dim(`(${hit.tech.join(', ')} · ${Math.round(hit.score * 100)} %)`)}`);
    lines.push(`     ${pc.dim('Cause :')} ${hit.cause}`);
    lines.push(`     ${pc.dim('Correction :')} ${hit.fix}`);
  });
  return lines.join('\n');
}

const STAGE_TEXT: Record<RadarStage, string> = {
  ciblee: 'aidants de ta techno',
  elargie: 'alerte élargie aux technos proches',
  publique: 'file publique : tous les aidants en ligne la voient',
};

/** Waits in the terminal until a helper accepts. Ctrl+C closes the request. */
/** Where the failing command ran: needed to apply corrections and relaunch it from the Salle SOS. */
export interface LocalRun {
  command: string[];
  cwd: string;
  root: string;
}

export async function waitHelper(sent: CreatedRequest, local?: LocalRun): Promise<number> {
  const config = readConfig();
  const server = serverUrl(config);
  console.log(pc.bold('\nRecherche d’un aidant…') + pc.dim(' (Ctrl+C pour annuler)'));
  const waiting = waitForHelper({
    server,
    token: config.token!,
    requestId: sent.id,
    onStatus: ({ stage, alerted, online }) => {
      const who = alerted > 0 ? `${alerted} aidant(s) alerté(s)` : online > 0 ? 'aucun aidant de ta techno en ligne' : 'aucun aidant en ligne pour l’instant';
      console.log(pc.dim(`  • ${STAGE_TEXT[stage]} : ${who}`));
    },
  });
  const cancel = () => {
    waiting.stop();
    void createApi(server, config.token)
      .closeRequest(sent.id)
      .catch(() => undefined)
      .finally(() => {
        console.log(pc.yellow('\nDemande annulée : les aidants ne la voient plus.'));
        process.exit(130);
      });
  };
  process.once('SIGINT', cancel);
  let helper;
  try {
    helper = await waiting.helper;
  } catch (error) {
    console.log(pc.yellow(`\n${(error as Error).message}. Ta demande reste visible des aidants.`));
    return 1;
  } finally {
    process.off('SIGINT', cancel);
  }
  console.log(pc.green(`\n✔ ${helper.name ?? helper.login} (@${helper.login}) a accepté ta demande !`));
  if (!local || !process.stdin.isTTY) {
    console.log(pc.dim('  Pas de terminal interactif : la salle SOS reste ouverte dans le navigateur de ton aidant.'));
    return 0;
  }
  const end = await openSalle({ server, token: config.token!, requestId: sent.id, ...local });
  return end === 'resolue' ? 0 : 1;
}

/** Sends a validated request; keeps it on disk if the server cannot take it. */
export async function deliver(request: SosRequest): Promise<CreatedRequest | null> {
  const config = readConfig();
  if (!config.token) {
    const file = saveRequest(request);
    console.log(pc.yellow('\nTu n’es pas connecté : lance « sos login », puis « sos send » pour l’envoyer.'));
    console.log(pc.dim(`  La demande est gardée sur ta machine : ${file}`));
    return null;
  }
  try {
    const sent = await createApi(serverUrl(config), config.token).sendRequest(request);
    console.log(pc.green(`\n✔ Demande envoyée (${sent.id.slice(0, 8)}).`));
    if (sent.secondPassMasked > 0) console.log(pc.yellow(`  Le serveur a masqué ${sent.secondPassMasked} secret(s) de plus.`));
    console.log(pc.dim(`  Ton code sera effacé du serveur au plus tard le ${new Date(sent.expiresAt).toLocaleString('fr-FR')}.`));
    return sent;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const file = saveRequest(request);
    console.log(pc.yellow(`\nEnvoi impossible : ${error.message}`));
    console.log(pc.dim(`  La demande est gardée sur ta machine : ${file}\n  Renvoie-la plus tard avec « sos send ${file} ».`));
    return null;
  }
}

export async function send(file: string | undefined): Promise<number> {
  if (!file) throw new CliError('indique le fichier de la demande : sos send ~/.sos/demandes/<fichier>.json');
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(`impossible de lire ${file}`);
  }
  const parsed = SosRequestSchema.safeParse(data);
  if (!parsed.success) throw new CliError(`${file} n’est pas une demande SOS valide`);
  const config = readConfig();
  if (!config.token) throw new CliError('tu n’es pas connecté : lance « sos login »');
  const sent = await createApi(serverUrl(config), config.token).sendRequest(parsed.data);
  fs.rmSync(file);
  console.log(pc.green(`✔ Demande envoyée (${sent.id.slice(0, 8)}). Le fichier local a été supprimé.`));
  return 0;
}
