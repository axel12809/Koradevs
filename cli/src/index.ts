#!/usr/bin/env node
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import { CliError, parseArgs, USAGE } from './args.js';
import { buildRequest, withoutFiles } from './build.js';
import { collectFiles } from './collect.js';
import { renderPreview } from './preview.js';
import { runCommand } from './run.js';
import { deliver, findSolutions, login, logout, renderSolutions, send, waitHelper, whoami } from './account.js';
import { ApiError } from './api.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(version);
    return 0;
  }
  if (args.subcommand) {
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    switch (args.subcommand) {
      case 'login':
        return login({ dev: args.dev, server: args.server });
      case 'logout':
        return logout();
      case 'whoami':
        return whoami();
      case 'send':
        return send(args.command[0]);
    }
  }
  if (args.help || args.command.length === 0) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }

  const cwd = process.cwd();
  if (!args.json) console.error(pc.dim(`sos ▸ ${args.command.join(' ')}`));
  const result = await runCommand(args.command, cwd, !args.json);

  if (result.exitCode === 0 && !args.force) {
    if (!args.json) console.error(pc.green('\n✔ Le programme s’est terminé sans erreur. Rien à envoyer.'));
    return 0;
  }

  const collected = collectFiles({ output: result.output, cwd, extra: args.add });
  let built = buildRequest({ command: args.command, exitCode: result.exitCode, output: result.output, files: collected.files, root: collected.root });

  if (args.json) {
    console.log(JSON.stringify(built.request, null, 2));
    return result.exitCode;
  }

  const hits = await findSolutions(built.request);
  if (hits.length) {
    console.log(renderSolutions(hits));
    if (!args.yes && !args.dryRun && process.stdin.isTTY) {
      const solved = await ask(pc.bold('\nUne fiche règle ton problème ? (o = oui, Entrée = appeler un humain) '));
      if (/^(o|oui|y|yes)$/i.test(solved)) {
        console.log(pc.green('Parfait. Rien n’a été envoyé.'));
        return result.exitCode;
      }
    }
  }

  console.log(renderPreview(built.request, collected.skipped, built.findings));

  if (args.dryRun) {
    console.log(pc.dim('\n--dry-run : rien n’a été envoyé.'));
    return result.exitCode;
  }

  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.log(pc.dim('\nPas de terminal interactif : relance avec --yes pour valider. Rien n’a été envoyé.'));
      return result.exitCode;
    }
    if (built.request.files.length > 0) {
      const answer = await ask(pc.bold('\nRetirer des fichiers ? Numéros séparés par des virgules (Entrée pour tout garder) : '));
      const removed = new Set(
        answer
          .split(/[\s,]+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= built.request.files.length)
          .map((n) => built.request.files[n - 1]!.path),
      );
      if (removed.size) {
        built = withoutFiles(built, removed);
        console.log(pc.dim(`Retirés : ${[...removed].join(', ')}`));
      }
    }
    const confirm = await ask(pc.bold('Envoyer cette demande ? (o/N) '));
    if (!/^(o|oui|y|yes)$/i.test(confirm)) {
      console.log(pc.dim('Annulé. Rien n’a été envoyé.'));
      return result.exitCode;
    }
  }

  const sent = await deliver(built.request);
  if (sent && !args.noWait) await waitHelper(sent, { command: args.command, cwd, root: collected.root });
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ApiError) {
      console.error(pc.red(`sos : ${error.message}`));
      process.exit(1);
    }
    if (error instanceof CliError) {
      console.error(pc.red(`sos : ${error.message}`));
      console.error(pc.dim('Lance « sos --help » pour voir l’aide.'));
      process.exit(2);
    }
    console.error(pc.red('sos : erreur inattendue'), error);
    process.exit(1);
  },
);
