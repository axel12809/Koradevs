import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { RadarService } from '../src/radar/radar.service.js';
import { payload, testApp } from './helpers.js';
import { Client, flush } from './ws-client.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

describe('Salle SOS', () => {
  let ctx: Ctx;
  let url: string;
  const clients: Client[] = [];
  const http = () => request(ctx.app.getHttpServer());

  const login = async (pseudo: string) => (await http().post('/auth/dev').send({ login: pseudo }).expect(200)).body.token as string;
  const connect = async (token: string) => {
    const c = new Client(url);
    clients.push(c);
    await c.opened;
    c.send({ type: 'auth', token });
    await c.next('bienvenue');
    return c;
  };

  /** koffi asks, awa accepts: returns the request id and both tokens. */
  const accepted = async () => {
    const koffi = await login('koffi');
    const awa = await login('awa');
    const id = (await http().post('/requests').set('Authorization', `Bearer ${koffi}`).send(payload()).expect(201)).body.id as string;
    const radar = await connect(awa);
    radar.send({ type: 'disponible', tech: ['JavaScript'] });
    await radar.next('alerte');
    radar.send({ type: 'accepter', requestId: id });
    await radar.next('prise');
    return { id, koffi, awa };
  };

  const join = async (token: string, requestId: string, client: 'terminal' | 'web') => {
    const c = await connect(token);
    c.send({ type: 'rejoindre', requestId, client });
    return { c, salle: (await c.next('salle')).salle };
  };

  beforeEach(async () => {
    ctx = await testApp({ radarTickMs: 0, webUrl: 'http://sos.test' });
    await ctx.app.listen(0, '127.0.0.1');
    url = `ws://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/ws`;
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await ctx.app.close();
  });

  it('opens only to the requester and the accepted helper', async () => {
    const { id, koffi, awa } = await accepted();
    const { salle } = await join(awa, id, 'web');
    expect(salle).toMatchObject({
      requestId: id,
      role: 'aidant',
      requester: { login: 'koffi' },
      helper: { login: 'awa' },
      files: [{ path: 'users.js', line: 2 }],
      url: `http://sos.test/#/salle/${id}`,
    });
    expect(salle.terminal).toContain('Cannot read properties of undefined');
    expect((await join(koffi, id, 'web')).salle.role).toBe('demandeur');

    const moussa = await connect(await login('moussa'));
    moussa.send({ type: 'rejoindre', requestId: id, client: 'web' });
    expect((await moussa.next('erreur')).message).toContain('réservée');
    moussa.send({ type: 'message', requestId: id, text: 'coucou' });
    await moussa.next('erreur');

    const helperTerminal = await connect(awa);
    helperTerminal.send({ type: 'rejoindre', requestId: id, client: 'terminal' });
    expect((await helperTerminal.next('erreur')).message).toContain('demandeur');
  });

  it('refuses rooms for requests that nobody accepted', async () => {
    const koffi = await login('koffi');
    const id = (await http().post('/requests').set('Authorization', `Bearer ${koffi}`).send(payload()).expect(201)).body.id as string;
    const c = await connect(koffi);
    c.send({ type: 'rejoindre', requestId: id, client: 'terminal' });
    expect((await c.next('erreur')).message).toContain('fermée');
  });

  it('shares code edits live through Yjs, including for late joiners', async () => {
    const { id, koffi, awa } = await accepted();
    const helper = await join(awa, id, 'web');
    const terminal = await join(koffi, id, 'terminal');

    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(helper.salle.doc, 'base64'));
    expect(doc.getText('users.js').toString()).toContain('user.name.toUpperCase()');
    const before = Y.encodeStateVector(doc);
    const text = doc.getText('users.js');
    const at = text.toString().indexOf('user.name');
    text.delete(at, 'user.name'.length);
    text.insert(at, 'user?.name ?? "invité"');
    helper.c.send({ type: 'yjs', requestId: id, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64') });

    const update = await terminal.c.next('yjs');
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, Buffer.from(terminal.salle.doc, 'base64'));
    Y.applyUpdate(mirror, Buffer.from(update.update, 'base64'));
    expect(mirror.getText('users.js').toString()).toContain('user?.name ?? "invité"');
    await flush();
    expect(helper.c.has('yjs')).toBe(false);

    const late = await join(koffi, id, 'web');
    const lateDoc = new Y.Doc();
    Y.applyUpdate(lateDoc, Buffer.from(late.salle.doc, 'base64'));
    expect(lateDoc.getText('users.js').toString()).toContain('user?.name ?? "invité"');
  });

  it('masks secrets in chat and terminal output, and keeps the terminal read-only for the helper', async () => {
    const { id, koffi, awa } = await accepted();
    const helper = await join(awa, id, 'web');
    const terminal = await join(koffi, id, 'terminal');

    terminal.c.send({ type: 'message', requestId: id, text: `essaie avec ${GITHUB_TOKEN}` });
    const chat = await helper.c.next('message');
    expect(chat.message).toMatchObject({ from: 'koffi', role: 'demandeur' });
    expect(chat.message.text).toContain('[MASQUÉ:');
    expect(chat.message.text).not.toContain(GITHUB_TOKEN);
    expect((await terminal.c.next('message')).message.id).toBe(chat.message.id);

    terminal.c.send({ type: 'execution', requestId: id, state: 'en-cours' });
    expect((await helper.c.next('execution')).state).toBe('en-cours');
    terminal.c.send({ type: 'terminal', requestId: id, data: `GITHUB_TOKEN=${GITHUB_TOKEN}\nBonjour AWA !\n` });
    const out = await helper.c.next('terminal');
    expect(out.data).toContain('Bonjour AWA !');
    expect(out.data).not.toContain(GITHUB_TOKEN);
    terminal.c.send({ type: 'execution', requestId: id, state: 'terminee', exitCode: 0 });
    expect(await helper.c.next('execution')).toMatchObject({ state: 'terminee', exitCode: 0 });

    helper.c.send({ type: 'terminal', requestId: id, data: 'rm -rf /' });
    helper.c.send({ type: 'reponse', requestId: id, path: 'users.js', accepted: true });
    await flush();
    expect(terminal.c.has('terminal')).toBe(false);
    expect(terminal.c.messages.some((m) => m.type === 'message')).toBe(false);

    const late = await join(awa, id, 'web');
    expect(late.salle.terminal).toBe(`GITHUB_TOKEN=[MASQUÉ:github-token]\nBonjour AWA !\n`.replace('github-token', late.salle.terminal.match(/MASQUÉ:([^\]]+)/)![1]!));
    expect(late.salle.lastExitCode).toBe(0);
    expect(late.salle.chat).toHaveLength(1);
  });

  it('sends corrections and relaunch requests to the terminal, which answers for the requester', async () => {
    const { id, koffi, awa } = await accepted();
    const helper = await join(awa, id, 'web');

    helper.c.send({ type: 'relance', requestId: id });
    expect((await helper.c.next('erreur')).message).toContain('terminal');

    const terminal = await join(koffi, id, 'terminal');
    expect((await helper.c.next('presence', (m) => m.members.length === 2)).members).toContainEqual({ login: 'koffi', role: 'demandeur', client: 'terminal' });

    helper.c.send({ type: 'proposer', requestId: id });
    expect(await terminal.c.next('proposition')).toMatchObject({ requestId: id, by: 'awa' });
    terminal.c.send({ type: 'reponse', requestId: id, path: 'users.js', accepted: true });
    expect((await helper.c.next('message', (m) => m.message.text.includes('appliquée'))).message).toMatchObject({ role: 'systeme' });
    terminal.c.send({ type: 'reponse', requestId: id, path: 'users.js', accepted: false, reason: 'pas maintenant' });
    expect((await helper.c.next('message', (m) => m.message.text.includes('refusée'))).message.text).toContain('pas maintenant');

    helper.c.send({ type: 'relance', requestId: id });
    expect(await terminal.c.next('relance-demandee')).toMatchObject({ by: 'awa' });
    await helper.c.next('message', (m) => m.message.text.includes('Entrée'));
    terminal.c.send({ type: 'reponse-relance', requestId: id, accepted: true });
    await helper.c.next('message', (m) => m.message.text === 'Relance autorisée.');

    // Proposals never reach the requester's browser: only the terminal can write files.
    const browser = await join(koffi, id, 'web');
    helper.c.send({ type: 'proposer', requestId: id });
    await terminal.c.next('proposition');
    await flush();
    expect(browser.c.has('proposition')).toBe(false);
  });

  it('« Problème résolu » closes the room for both sides and erases the code', async () => {
    const { id, koffi, awa } = await accepted();
    const helper = await join(awa, id, 'web');
    const terminal = await join(koffi, id, 'terminal');

    helper.c.send({ type: 'resolu', requestId: id });
    expect(await terminal.c.next('salle-fermee')).toMatchObject({ raison: 'resolue', by: 'awa' });
    expect(await helper.c.next('salle-fermee')).toMatchObject({ raison: 'resolue' });
    expect(await ctx.store.getRequest(id, ctx.clock.now)).toBeNull();
    expect(await ctx.store.purgeExpired(ctx.clock.now)).toMatchObject({ requests: 1 });

    helper.c.send({ type: 'rejoindre', requestId: id, client: 'web' });
    await helper.c.next('erreur');
    helper.c.send({ type: 'message', requestId: id, text: 'encore là ?' });
    expect((await helper.c.next('erreur')).message).toContain('Rejoins');
  });

  it('closes the room when the requester cancels or the request expires', async () => {
    const first = await accepted();
    const helper = await join(first.awa, first.id, 'web');
    await http().post(`/requests/${first.id}/close`).set('Authorization', `Bearer ${first.koffi}`).expect(204);
    expect(await helper.c.next('salle-fermee')).toMatchObject({ raison: 'annulee', by: 'koffi' });

    const koffi = first.koffi;
    const id = (await http().post('/requests').set('Authorization', `Bearer ${koffi}`).send(payload()).expect(201)).body.id as string;
    const radar = await connect(first.awa);
    radar.send({ type: 'disponible', tech: ['JavaScript'] });
    await radar.next('alerte', (m) => m.alert.requestId === id);
    radar.send({ type: 'accepter', requestId: id });
    await radar.next('prise');
    const second = await join(first.awa, id, 'web');
    ctx.advance(24 * 60 + 1);
    await ctx.app.get(RadarService).tick();
    expect(await second.c.next('salle-fermee')).toMatchObject({ raison: 'expiree' });
  });
});
