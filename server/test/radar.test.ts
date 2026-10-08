import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { RadarService } from '../src/radar/radar.service.js';
import { payload, testApp } from './helpers.js';
import { Client, flush } from './ws-client.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;


describe('Radar temps réel', () => {
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
  const helper = async (pseudo: string, tech: string[]) => {
    const c = await connect(await login(pseudo));
    c.send({ type: 'disponible', tech });
    await flush();
    return c;
  };
  const ask = async (token: string, tech = ['JavaScript']) =>
    (await http().post('/requests').set('Authorization', `Bearer ${token}`).send(payload({ tech })).expect(201)).body.id as string;
  const tick = () => ctx.app.get(RadarService).tick();

  beforeEach(async () => {
    ctx = await testApp({ radarTickMs: 0 });
    await ctx.app.listen(0, '127.0.0.1');
    url = `ws://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/ws`;
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await ctx.app.close();
  });

  it('rejects unauthenticated sockets', async () => {
    const c = new Client(url);
    clients.push(c);
    await c.opened;
    c.send({ type: 'disponible', tech: ['JavaScript'] });
    expect((await c.next('erreur')).message).toContain('Authentification');
    c.send({ type: 'auth', token: 'sos_faux' });
    await c.next('erreur');
  });

  it('alerts same-tech helpers first, close techs after 2 min, everyone after 5 min', async () => {
    const js = await helper('awa', ['JavaScript']);
    const ts = await helper('moussa', ['TypeScript']);
    const py = await helper('fatou', ['Python']);
    const requester = await login('koffi');
    const watcher = await connect(requester);
    const id = await ask(requester);
    watcher.send({ type: 'suivre', requestId: id });

    const alert = await js.next('alerte');
    expect(alert.alert).toMatchObject({ requestId: id, stage: 'ciblee', requester: 'koffi', tech: ['JavaScript'], files: 1 });
    expect(alert.alert.errorSummary).toContain("Cannot read properties of undefined");
    expect(await watcher.next('statut')).toMatchObject({ stage: 'ciblee', alerted: 1, online: 3 });
    await flush();
    expect(ts.has('alerte')).toBe(false);
    expect(py.has('alerte')).toBe(false);

    ctx.advance(2);
    await tick();
    expect((await ts.next('alerte')).alert.stage).toBe('elargie');
    expect((await watcher.next('statut')).alerted).toBe(2);
    expect(py.has('alerte')).toBe(false);

    ctx.advance(3);
    await tick();
    expect((await py.next('alerte')).alert.stage).toBe('publique');
    expect(await watcher.next('statut')).toMatchObject({ stage: 'publique', alerted: 3 });
  });

  it('tells a requester who starts following after the helper already accepted', async () => {
    const awa = await helper('awa', ['JavaScript']);
    const requester = await login('koffi');
    const id = await ask(requester);
    await awa.next('alerte');
    awa.send({ type: 'accepter', requestId: id });
    await awa.next('prise');
    const watcher = await connect(requester);
    watcher.send({ type: 'suivre', requestId: id });
    expect(await watcher.next('acceptee')).toMatchObject({ requestId: id, helper: { login: 'awa' } });
  });

  it('gives the request to the first helper only and tells the requester', async () => {
    const awa = await helper('awa', ['JavaScript']);
    const moussa = await helper('moussa', ['JavaScript', 'React']);
    const requester = await login('koffi');
    const watcher = await connect(requester);
    const id = await ask(requester);
    watcher.send({ type: 'suivre', requestId: id });
    await awa.next('alerte');
    await moussa.next('alerte');

    awa.send({ type: 'accepter', requestId: id });
    moussa.send({ type: 'accepter', requestId: id });

    expect((await awa.next('prise')).requester.login).toBe('koffi');
    expect((await watcher.next('acceptee')).helper.login).toBe('awa');
    await moussa.next('retirer', (m) => m.requestId === id && m.raison === 'prise');
    expect((await moussa.next('erreur')).message).toMatch(/déjà prise|Trop tard/);

    const detail = await http().get('/requests').set('Authorization', `Bearer ${requester}`).expect(200);
    expect(detail.body[0].status).toBe('acceptee');
  });

  it('never alerts the requester and refuses to follow someone else’s request', async () => {
    const requester = await login('koffi');
    const self = await connect(requester);
    self.send({ type: 'disponible', tech: ['JavaScript'] });
    await flush();
    const id = await ask(requester);
    await flush();
    expect(self.has('alerte')).toBe(false);
    self.send({ type: 'accepter', requestId: id });
    expect((await self.next('erreur')).message).toContain('propre demande');

    const other = await connect(await login('awa'));
    other.send({ type: 'suivre', requestId: id });
    expect((await other.next('erreur')).message).toContain('introuvable');
  });

  it('removes the alert when the requester closes the request, and on pause', async () => {
    const awa = await helper('awa', ['JavaScript']);
    const requester = await login('koffi');
    const id = await ask(requester);
    await awa.next('alerte');
    await http().post(`/requests/${id}/close`).set('Authorization', `Bearer ${requester}`).expect(204);
    await awa.next('retirer', (m) => m.requestId === id);
    await http().post(`/requests/${id}/close`).set('Authorization', `Bearer ${await login('awa')}`).expect(403);

    const second = await ask(requester);
    await awa.next('alerte', (m) => m.alert.requestId === second);
    awa.send({ type: 'pause' });
    await flush();
    awa.send({ type: 'accepter', requestId: second });
    expect((await awa.next('erreur')).message).toContain('pas proposée');
  });
});
