import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { errorSummary, relatedTech, type RadarAlert, type RadarStage, type ServerMessage } from '@sos/shared';
import { AuthService, publicUser } from '../auth/auth.service.js';
import type { AppConfig } from '../config.js';
import type { Store, StoredRequest, User } from '../store/types.js';
import { CLOCK, CONFIG, STORE, type Clock } from '../tokens.js';
import { SalleService, type SalleConnection } from '../salle/salle.service.js';

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(200) }),
  z.object({ type: z.literal('disponible'), tech: z.array(z.string().trim().min(1).max(40)).min(1).max(20) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('suivre'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('accepter'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('rejoindre'), requestId: z.string().uuid(), client: z.enum(['terminal', 'web']) }),
  z.object({ type: z.literal('yjs'), requestId: z.string().uuid(), update: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal('message'), requestId: z.string().uuid(), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('proposer'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('relance'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('resolu'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('terminal'), requestId: z.string().uuid(), data: z.string().max(64_000) }),
  z.object({ type: z.literal('execution'), requestId: z.string().uuid(), state: z.enum(['en-cours', 'terminee']), exitCode: z.number().int().optional() }),
  z.object({ type: z.literal('reponse'), requestId: z.string().uuid(), path: z.string().min(1).max(500), accepted: z.boolean(), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('reponse-relance'), requestId: z.string().uuid(), accepted: z.boolean() }),
]);

interface Connection extends SalleConnection {
  ws: WebSocket;
  user: User | null;
  /** Messages of one connection are handled one after the other, in order. */
  queue: Promise<void>;
  /** null = not available (Radar paused or requester only). */
  tech: string[] | null;
  /** Alerts already sent: request id → stage. */
  sent: Map<string, RadarStage>;
  /** Requests followed by their author (the `sos` terminal). */
  watching: Set<string>;
}

const AUTH_TIMEOUT_MS = 10_000;

/**
 * Real-time Radar over WebSocket (`/ws`).
 * Helpers declare their techs and get alerts: same tech first, close techs after
 * `widenAfterSeconds`, everyone after `publicAfterSeconds`. The first to accept wins.
 * Requesters follow their request and see who was alerted, then who accepted.
 */
@Injectable()
export class RadarService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Radar');
  private readonly connections = new Set<Connection>();
  private readonly lastStatus = new Map<string, string>();
  private wss: WebSocketServer | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(STORE) private readonly store: Store,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(SalleService) private readonly salle: SalleService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.host.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    if (this.config.radarTickMs > 0) {
      this.timer = setInterval(() => void this.tick().catch((e: unknown) => this.logger.error(e)), this.config.radarTickMs);
      this.timer.unref();
    }
  }

  beforeApplicationShutdown(): void {
    clearInterval(this.timer);
    for (const c of this.connections) c.ws.terminate();
    this.wss?.close();
  }

  stageOf(request: StoredRequest, now = this.now()): RadarStage {
    const age = (now.getTime() - request.createdAt.getTime()) / 1000;
    if (age >= this.config.publicAfterSeconds) return 'publique';
    if (age >= this.config.widenAfterSeconds) return 'elargie';
    return 'ciblee';
  }

  private visibleTo(request: StoredRequest, c: Connection, stage: RadarStage): boolean {
    if (!c.user || !c.tech || request.userId === c.user.id) return false;
    if (stage === 'publique' || request.tech.length === 0) return true;
    const wanted = stage === 'ciblee' ? request.tech : relatedTech(request.tech);
    return c.tech.some((t) => wanted.includes(t));
  }

  /** Re-computes who sees what. Runs on a timer and after every change; never runs twice at once. */
  tick(): Promise<void> {
    const run = async () => {
      if (this.ticking) await this.ticking.catch(() => undefined);
      await this.refresh();
    };
    const current = run();
    this.ticking = current.finally(() => {
      if (this.ticking === current) this.ticking = undefined;
    });
    return current;
  }

  private async refresh(): Promise<void> {
    const now = this.now();
    this.salle.sweep(now);
    const open = await this.store.listOpenRequests(now);
    const openIds = new Set(open.map((r) => r.id));
    const helpers = [...this.connections].filter((c) => c.user && c.tech);
    const logins = new Map<string, string>();

    for (const request of open) {
      const stage = this.stageOf(request, now);
      for (const c of helpers) {
        if (!this.visibleTo(request, c, stage) || c.sent.get(request.id) === stage) continue;
        if (!logins.has(request.userId)) logins.set(request.userId, (await this.store.getUser(request.userId))?.login ?? '?');
        c.sent.set(request.id, stage);
        this.send(c, { type: 'alerte', alert: this.alertOf(request, stage, logins.get(request.userId)!) });
      }
    }

    for (const c of helpers) {
      for (const id of c.sent.keys()) {
        if (openIds.has(id)) continue;
        c.sent.delete(id);
        this.send(c, { type: 'retirer', requestId: id, raison: 'fermee' });
      }
    }

    for (const request of open) {
      const others = helpers.filter((c) => c.user!.id !== request.userId);
      const alerted = others.filter((c) => c.sent.has(request.id)).length;
      const status: ServerMessage = { type: 'statut', requestId: request.id, stage: this.stageOf(request, now), alerted, online: others.length };
      const key = JSON.stringify(status);
      if (this.lastStatus.get(request.id) === key) continue;
      this.lastStatus.set(request.id, key);
      for (const c of this.connections) if (c.watching.has(request.id)) this.send(c, status);
    }
    for (const id of this.lastStatus.keys()) if (!openIds.has(id)) this.lastStatus.delete(id);
  }

  private alertOf(r: StoredRequest, stage: RadarStage, requester: string): RadarAlert {
    return {
      requestId: r.id,
      tech: r.tech,
      command: r.command,
      errorSummary: errorSummary(r.payload.output),
      files: r.payload.files.length,
      stage,
      requester,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private onConnection(ws: WebSocket): void {
    const c: Connection = {
      ws,
      user: null,
      queue: Promise.resolve(),
      tech: null,
      sent: new Map(),
      watching: new Set(),
      send: (message) => this.send(c, message),
    };
    this.connections.add(c);
    const authTimer = setTimeout(() => {
      if (!c.user) ws.close(4001, 'auth requise');
    }, AUTH_TIMEOUT_MS);
    ws.on('message', (data) => {
      c.queue = c.queue
        .then(() => this.onMessage(c, data))
        .catch((e: unknown) => {
          this.logger.error(e);
          this.send(c, { type: 'erreur', message: 'Erreur interne du serveur.' });
        });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const wasHelper = !!c.tech;
      this.connections.delete(c);
      this.salle.leave(c);
      if (wasHelper) void this.tick().catch((e: unknown) => this.logger.error(e));
    });
  }

  private async onMessage(c: Connection, data: RawData): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return this.send(c, { type: 'erreur', message: 'Message illisible.' });
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) return this.send(c, { type: 'erreur', message: 'Message invalide.' });
    const message = parsed.data;

    if (message.type === 'auth') {
      const user = await this.auth.authenticate(message.token);
      if (!user) {
        this.send(c, { type: 'erreur', message: 'Session expirée : reconnecte-toi.' });
        return c.ws.close(4001, 'session invalide');
      }
      c.user = user;
      return this.send(c, { type: 'bienvenue', user: publicUser(user) });
    }
    const user = c.user;
    if (!user) return this.send(c, { type: 'erreur', message: 'Authentification requise.' });

    switch (message.type) {
      case 'disponible': {
        const tech = [...new Set(message.tech)];
        await this.store.setHelperTech(user.id, tech);
        c.tech = tech;
        c.sent.clear();
        return this.tick();
      }
      case 'pause':
        c.tech = null;
        c.sent.clear();
        return this.tick();
      case 'suivre': {
        const request = await this.store.getRequest(message.requestId, this.now());
        if (!request || request.userId !== user.id) return this.send(c, { type: 'erreur', message: 'Demande introuvable.' });
        c.watching.add(request.id);
        this.lastStatus.delete(request.id);
        return this.tick();
      }
      case 'accepter':
        return this.accept(c, user, message.requestId);
      case 'rejoindre':
        return this.salle.join(c, message.requestId, message.client);
      case 'resolu':
        return this.salle.resolve(c, message.requestId);
      default:
        return this.salle.handle(c, message);
    }
  }

  private async accept(c: Connection, helper: User, requestId: string): Promise<void> {
    const now = this.now();
    const request = await this.store.getRequest(requestId, now);
    if (!request || request.status !== 'ouverte') return this.send(c, { type: 'erreur', message: 'Demande déjà prise ou fermée.' });
    if (request.userId === helper.id) return this.send(c, { type: 'erreur', message: 'Tu ne peux pas prendre ta propre demande.' });
    if (!this.visibleTo(request, c, this.stageOf(request, now))) {
      return this.send(c, { type: 'erreur', message: 'Cette demande ne t’est pas proposée.' });
    }
    const accepted = await this.store.acceptRequest(requestId, helper.id, now);
    if (!accepted) return this.send(c, { type: 'erreur', message: 'Trop tard : un autre aidant a pris la demande.' });

    const requester = await this.store.getUser(accepted.userId);
    c.sent.delete(requestId);
    this.send(c, { type: 'prise', requestId, requester: publicUser(requester!) });
    for (const other of this.connections) {
      if (other.watching.delete(requestId)) this.send(other, { type: 'acceptee', requestId, helper: publicUser(helper) });
      if (other !== c && other.sent.delete(requestId)) this.send(other, { type: 'retirer', requestId, raison: 'prise' });
    }
    this.lastStatus.delete(requestId);
    this.logger.log(`${helper.login} a pris la demande ${requestId.slice(0, 8)} de ${requester?.login}`);
  }

  private send(c: Connection, message: ServerMessage): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(message));
  }
}
