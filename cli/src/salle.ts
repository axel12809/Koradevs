import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import pc from 'picocolors';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { maskSecrets, type ClientMessage, type SalleState, type ServerMessage } from '@sos/shared';
import { prepareCorrection, writeCorrection } from './patch.js';
import { runCommand } from './run.js';

export interface SalleOptions {
  server: string;
  token: string;
  requestId: string;
  /** The command to relaunch, in `cwd`. */
  command: string[];
  cwd: string;
  /** Project root: shared files are relative to it. */
  root: string;
  input?: Readable;
  output?: Writable;
}

export type SalleEnd = 'resolue' | 'annulee' | 'expiree' | 'quittee' | 'perdue';

const YES = /^(o|oui|y|yes)$/i;
const CHUNK = 32 * 1024;

function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .slice(2)
    .map((line) => (line.startsWith('+') ? pc.green(line) : line.startsWith('-') ? pc.red(line) : line.startsWith('@@') ? pc.cyan(line) : pc.dim(line)))
    .join('\n');
}

/**
 * The requester's side of the Salle SOS. `sos` stays open after a helper accepts: it streams each
 * relaunch to the room, shows the helper's corrections as diffs and writes them only after « o »,
 * and relaunches only when the requester presses Enter. Other lines typed here go to the chat.
 */
export function openSalle(options: SalleOptions): Promise<SalleEnd> {
  const out = options.output ?? process.stdout;
  const log = (text = '') => out.write(text + '\n');
  const ws = new WebSocket(options.server.replace(/^http/, 'ws') + '/ws');
  const send = (message: ClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const rl = readline.createInterface({ input: options.input ?? process.stdin, output: out, terminal: false });
  const doc = new Y.Doc();
  let state: SalleState | null = null;
  let pending: ((line: string) => void) | null = null;
  let queue = Promise.resolve();
  let helperOnline = false;
  const requestId = options.requestId;

  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      out.write(pc.bold(question));
      pending = (line) => {
        pending = null;
        resolve(line.trim());
      };
    });
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      log(pc.red(`sos : ${(error as Error).message}`));
    });
  };

  const relaunch = async () => {
    send({ type: 'execution', requestId, state: 'en-cours' });
    log(pc.dim(`\nsos ▸ ${options.command.join(' ')}`));
    let partial = '';
    const stream = (text: string) => {
      // Secrets are masked line by line, so that none is cut in two between chunks.
      for (let i = 0; i < text.length; i += CHUNK) send({ type: 'terminal', requestId, data: maskSecrets(text.slice(i, i + CHUNK)).text });
    };
    const result = await runCommand(options.command, options.cwd, true, {
      stdin: 'ignore',
      onOutput: (text) => {
        partial += text;
        const cut = partial.lastIndexOf('\n') + 1;
        if (cut > 0) {
          stream(partial.slice(0, cut));
          partial = partial.slice(cut);
        }
      },
    });
    if (partial) stream(partial);
    send({ type: 'execution', requestId, state: 'terminee', exitCode: result.exitCode });
    log(result.exitCode === 0 ? pc.green('\n✔ Le programme s’est terminé sans erreur. Tape /resolu si c’est réglé.') : pc.yellow(`\nCode de sortie ${result.exitCode}.`));
  };

  const review = async (by: string) => {
    if (!state) return;
    const shared = state.files.map((f) => f.path);
    let changed = 0;
    for (const path of shared) {
      const correction = prepareCorrection(options.root, shared, path, doc.getText(path).toString());
      if (correction.kind === 'identique') continue;
      changed += 1;
      if (correction.kind === 'refusee') {
        log(pc.yellow(`\n✗ Correction de ${path} ignorée : ${correction.reason}.`));
        send({ type: 'reponse', requestId, path, accepted: false, reason: correction.reason });
        continue;
      }
      log(pc.bold(`\n@${by} propose une correction de ${path} :`));
      log(colorDiff(correction.diff));
      if (YES.test(await ask(`Appliquer sur ta machine ? (o/N) `))) {
        writeCorrection(correction);
        log(pc.green(`✔ ${path} modifié.`));
        send({ type: 'reponse', requestId, path, accepted: true });
      } else {
        log(pc.dim('Rien n’a été écrit.'));
        send({ type: 'reponse', requestId, path, accepted: false, reason: 'refusée par le demandeur' });
      }
    }
    if (changed === 0) {
      log(pc.dim(`\n@${by} a proposé ses modifications, mais elles sont identiques à tes fichiers.`));
      send({ type: 'message', requestId, text: 'Aucune différence avec mes fichiers.' });
    }
  };

  return new Promise<SalleEnd>((resolve) => {
    let ended = false;
    const finish = (end: SalleEnd) => {
      if (ended) return;
      ended = true;
      rl.close();
      ws.close();
      doc.destroy();
      process.off('SIGINT', quit);
      resolve(end);
    };
    const quit = () => {
      log(pc.yellow('\nTu as quitté la salle. L’aidant ne peut plus rien t’envoyer.'));
      finish('quittee');
    };
    process.once('SIGINT', quit);

    rl.on('line', (line) => {
      if (pending) return pending(line);
      const text = line.trim();
      if (!text || !state) return;
      if (text === '/resolu') return send({ type: 'resolu', requestId });
      if (text === '/quitter') return quit();
      if (text === '/relance') return enqueue(relaunch);
      if (text === '/aide') return log(pc.dim('Écris un message puis Entrée pour le chat · /relance · /resolu · /quitter'));
      send({ type: 'message', requestId, text });
    });
    rl.on('close', () => {
      // stdin closed (Ctrl+D): leave the room.
      if (!ended) quit();
    });

    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: options.token })));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      switch (message.type) {
        case 'bienvenue':
          return send({ type: 'rejoindre', requestId, client: 'terminal' });
        case 'salle':
          state = message.salle;
          Y.applyUpdate(doc, Buffer.from(state.doc, 'base64'));
          log(pc.bold(`\n━━ Salle SOS avec @${state.helper.login} ━━`));
          log(`  Salle dans le navigateur : ${pc.cyan(state.url)}`);
          log(pc.dim('  Écris un message puis Entrée pour parler à ton aidant.'));
          log(pc.dim('  Ses corrections et ses demandes de relance attendent toujours ton accord.'));
          log(pc.dim('  /relance pour relancer toi-même · /resolu quand c’est réglé · /quitter ou Ctrl+C pour partir'));
          return;
        case 'yjs':
          return Y.applyUpdate(doc, Buffer.from(message.update, 'base64'));
        case 'message':
          if (message.message.role === 'demandeur') return;
          return log(message.message.role === 'systeme' ? pc.dim(`  · ${message.message.text}`) : `${pc.magenta(`@${message.message.from}`)} : ${message.message.text}`);
        case 'presence': {
          const online = message.members.some((m) => m.role === 'aidant');
          if (online !== helperOnline && state) log(pc.dim(online ? `  · @${state.helper.login} est dans la salle.` : `  · @${state.helper.login} a quitté la salle.`));
          helperOnline = online;
          return;
        }
        case 'proposition':
          return enqueue(() => review(message.by));
        case 'relance-demandee':
          return enqueue(async () => {
            const answer = await ask(`\n@${message.by} demande une relance de « ${options.command.join(' ')} ». Entrée pour lancer, n pour refuser : `);
            const accepted = !/^(n|non|no)$/i.test(answer);
            send({ type: 'reponse-relance', requestId, accepted });
            if (accepted) await relaunch();
            else log(pc.dim('Relance refusée.'));
          });
        case 'salle-fermee': {
          const text = {
            resolue: `✔ Problème résolu${message.by ? ` (@${message.by})` : ''}. La salle est fermée et ton code est effacé du serveur.`,
            annulee: 'La demande a été annulée. La salle est fermée.',
            expiree: 'La salle a expiré : ton code est effacé du serveur.',
          }[message.raison];
          log(message.raison === 'resolue' ? pc.green(`\n${text}`) : pc.yellow(`\n${text}`));
          return finish(message.raison);
        }
        case 'erreur':
          log(pc.red(`sos : ${message.message}`));
          if (!state) finish('perdue');
          return;
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (!ended) {
        log(pc.yellow('\nConnexion à la salle perdue.'));
        finish('perdue');
      }
    });
  });
}
