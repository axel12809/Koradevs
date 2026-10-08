import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { maskSecrets, type ClientMessage, type SalleState, type ServerMessage } from '@sos/shared';
import { openSalle } from '../src/salle.js';

const ID = '2b1f6f0e-3c1a-4a8e-9a39-7c1d2f9e8a10';
const SECRET = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const ORIGINAL = `const token = "${SECRET}";\nexport const greet = (user) => \`Bonjour \${user.name.toUpperCase()} !\`;\n`;

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`jamais arrivé : ${what}`);
}

describe('sos dans la salle SOS', () => {
  let root: string;
  let wss: WebSocketServer;
  let socket: WebSocket | null;
  let received: ClientMessage[];
  let doc: Y.Doc;
  let input: PassThrough;
  let screen: string;
  let output: PassThrough;

  const push = (m: ServerMessage) => socket!.send(JSON.stringify(m));
  const edit = (from: string, to: string) => {
    const text = doc.getText('users.js');
    const before = Y.encodeStateVector(doc);
    const at = text.toString().indexOf(from);
    text.delete(at, from.length);
    text.insert(at, to);
    push({ type: 'yjs', requestId: ID, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64') });
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-salle-'));
    fs.writeFileSync(path.join(root, 'users.js'), ORIGINAL);
    received = [];
    screen = '';
    input = new PassThrough();
    output = new PassThrough();
    output.on('data', (chunk: Buffer) => (screen += chunk.toString('utf8')));
    doc = new Y.Doc();
    doc.getText('users.js').insert(0, maskSecrets(ORIGINAL).text);
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/ws' });
    wss.on('connection', (ws) => {
      socket = ws;
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as ClientMessage;
        received.push(m);
        if (m.type === 'auth') push({ type: 'bienvenue', user: { id: 'u1', login: 'koffi', name: null, avatarUrl: null, provider: 'dev' } });
        if (m.type === 'rejoindre') {
          const salle = {
            requestId: ID,
            role: 'demandeur',
            requester: { login: 'koffi' },
            helper: { login: 'awa' },
            files: [{ path: 'users.js', line: 2 }],
            doc: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
            url: `http://sos.test/#/salle/${ID}`,
          } as unknown as SalleState;
          push({ type: 'salle', salle });
        }
      });
    });
    await new Promise((r) => wss.once('listening', r));
  });
  afterEach(() => {
    wss.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = () =>
    openSalle({
      server: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      token: 'sos_test',
      requestId: ID,
      command: [process.execPath, '-e', `console.log("Bonjour AWA ${SECRET}")`],
      cwd: root,
      root,
      input,
      output,
    });

  it('applies a correction only after « o », relaunches only after Enter, and ends on « résolu »', async () => {
    const ended = start();
    await until(() => screen.includes('Salle SOS avec @awa'), 'la salle');
    expect(received).toContainEqual({ type: 'rejoindre', requestId: ID, client: 'terminal' });

    edit('user.name', 'user?.name');
    push({ type: 'proposition', requestId: ID, by: 'awa' });
    await until(() => screen.includes('Appliquer sur ta machine'), 'la question o/n');
    expect(screen).toContain('+export const greet = (user) => `Bonjour ${user?.name.toUpperCase()} !`;');
    expect(screen).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(root, 'users.js'), 'utf8')).toBe(ORIGINAL);
    input.write('o\n');
    await until(() => received.some((m) => m.type === 'reponse'), 'la réponse');
    expect(received).toContainEqual({ type: 'reponse', requestId: ID, path: 'users.js', accepted: true });
    expect(fs.readFileSync(path.join(root, 'users.js'), 'utf8')).toBe(ORIGINAL.replace('user.name', 'user?.name'));

    edit('toUpperCase', 'toLowerCase');
    push({ type: 'proposition', requestId: ID, by: 'awa' });
    await until(() => screen.split('Appliquer sur ta machine').length === 3, 'la deuxième question');
    input.write('\n');
    await until(() => received.filter((m) => m.type === 'reponse').length === 2, 'le refus');
    expect(received.at(-1)).toMatchObject({ type: 'reponse', accepted: false });
    expect(fs.readFileSync(path.join(root, 'users.js'), 'utf8')).not.toContain('toLowerCase');

    push({ type: 'relance-demandee', requestId: ID, by: 'awa' });
    await until(() => screen.includes('Entrée pour lancer'), 'la question de relance');
    expect(received.some((m) => m.type === 'execution')).toBe(false);
    input.write('\n');
    await until(() => received.some((m) => m.type === 'execution' && m.state === 'terminee'), 'la fin de la relance');
    expect(received).toContainEqual({ type: 'reponse-relance', requestId: ID, accepted: true });
    expect(received).toContainEqual({ type: 'execution', requestId: ID, state: 'terminee', exitCode: 0 });
    const terminal = received.flatMap((m) => (m.type === 'terminal' ? [m.data] : [])).join('');
    expect(terminal).toContain('Bonjour AWA');
    expect(terminal).not.toContain(SECRET);

    push({ type: 'relance-demandee', requestId: ID, by: 'awa' });
    await until(() => screen.split('Entrée pour lancer').length === 3, 'la deuxième relance');
    input.write('n\n');
    await until(() => received.filter((m) => m.type === 'reponse-relance').length === 2, 'le refus de relance');
    expect(received.at(-1)).toEqual({ type: 'reponse-relance', requestId: ID, accepted: false });
    expect(received.filter((m) => m.type === 'execution')).toHaveLength(2);

    input.write('merci beaucoup\n');
    await until(() => received.some((m) => m.type === 'message'), 'le message');
    expect(received.at(-1)).toEqual({ type: 'message', requestId: ID, text: 'merci beaucoup' });
    push({ type: 'message', requestId: ID, message: { id: 1, from: 'awa', role: 'aidant', text: 'avec plaisir', at: '' } });
    await until(() => screen.includes('avec plaisir'), 'la réponse de l’aidant');

    input.write('/resolu\n');
    await until(() => received.some((m) => m.type === 'resolu'), 'résolu');
    push({ type: 'salle-fermee', requestId: ID, raison: 'resolue', by: 'koffi' });
    expect(await ended).toBe('resolue');
    expect(screen).toContain('ton code est effacé du serveur');
  });
});
