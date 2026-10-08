import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import {
  errorSummary,
  maskSecrets,
  type ChatMessage,
  type PublicUser,
  type SalleClient,
  type SalleMember,
  type SalleRole,
  type SalleState,
  type ServerMessage,
} from '@sos/shared';
import { publicUser } from '../auth/auth.service.js';
import type { AppConfig } from '../config.js';
import type { Store, StoredRequest, User } from '../store/types.js';
import { CLOCK, CONFIG, STORE, type Clock } from '../tokens.js';

/** What the Salle needs from a WebSocket connection. */
export interface SalleConnection {
  user: User | null;
  send(message: ServerMessage): void;
}

interface Member {
  conn: SalleConnection;
  role: SalleRole;
  client: SalleClient;
}

interface Room {
  requestId: string;
  requester: PublicUser;
  helper: PublicUser;
  command: string;
  tech: string[];
  errorSummary: string;
  files: SalleState['files'];
  doc: Y.Doc;
  chat: ChatMessage[];
  terminal: string;
  running: boolean;
  lastExitCode: number | null;
  expiresAt: Date;
  members: Set<Member>;
  nextMessageId: number;
}

const MAX_CHAT = 500;
const MAX_TERMINAL_CHARS = 100_000;
/** The shared code may grow while helping, but not without limit. */
const MAX_DOC_CHARS = 1_000_000;

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const mask = (text: string) => maskSecrets(text).text;

/**
 * Salle SOS: one room per accepted request, open to its requester and its helper only.
 * Shared code (Yjs document, one Y.Text per shared file), chat, and the requester's terminal
 * streamed read-only. The terminal (`sos`) applies corrections and relaunches only after the
 * requester's explicit consent. Rooms live in memory; the code stays erased with the request.
 */
@Injectable()
export class SalleService {
  private readonly logger = new Logger('Salle');
  private readonly rooms = new Map<string, Room>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async join(conn: SalleConnection, requestId: string, client: SalleClient): Promise<void> {
    const user = conn.user!;
    const request = await this.store.getRequest(requestId, this.now());
    const role: SalleRole | null = !request ? null : request.userId === user.id ? 'demandeur' : request.helperId === user.id ? 'aidant' : null;
    if (!request || !role) return conn.send({ type: 'erreur', message: 'Salle introuvable, ou réservée au demandeur et à son aidant.' });
    if (request.status !== 'acceptee') return conn.send({ type: 'erreur', message: 'Cette salle est fermée.' });
    if (client === 'terminal' && role !== 'demandeur') return conn.send({ type: 'erreur', message: 'Seul le demandeur relie son terminal.' });

    const room = this.rooms.get(requestId) ?? (await this.open(request));
    for (const m of room.members) if (m.conn === conn) room.members.delete(m);
    room.members.add({ conn, role, client });
    conn.send({ type: 'salle', salle: this.stateOf(room, role) });
    this.broadcastPresence(room);
  }

  /** Every Salle message except `rejoindre`. Synchronous so that a connection's messages keep their order. */
  handle(conn: SalleConnection, message: { type: string; requestId: string } & Record<string, unknown>): void {
    const room = this.rooms.get(message.requestId);
    const member = room && [...room.members].find((m) => m.conn === conn);
    if (!room || !member) return conn.send({ type: 'erreur', message: 'Rejoins la salle d’abord.' });
    const login = conn.user!.login;
    const fromTerminal = member.client === 'terminal';

    switch (message.type) {
      case 'yjs': {
        const update = Buffer.from(String(message.update), 'base64');
        try {
          Y.applyUpdate(room.doc, update, member);
        } catch {
          return conn.send({ type: 'erreur', message: 'Modification illisible.' });
        }
        if (this.docSize(room) > MAX_DOC_CHARS) this.logger.warn(`Salle ${room.requestId.slice(0, 8)} : code partagé très volumineux.`);
        return this.broadcast(room, { type: 'yjs', requestId: room.requestId, update: String(message.update) }, member);
      }
      case 'message':
        return this.say(room, login, member.role, mask(String(message.text)));
      case 'proposer':
        if (!this.terminalOnline(room)) return conn.send({ type: 'erreur', message: 'Le terminal du demandeur n’est pas relié à la salle.' });
        this.say(room, 'SOS', 'systeme', `@${login} propose ses modifications : le demandeur valide chaque fichier dans son terminal.`);
        return this.toTerminal(room, { type: 'proposition', requestId: room.requestId, by: login });
      case 'relance':
        if (!this.terminalOnline(room)) return conn.send({ type: 'erreur', message: 'Le terminal du demandeur n’est pas relié à la salle.' });
        this.say(room, 'SOS', 'systeme', `@${login} demande une relance : le demandeur appuie sur Entrée pour l’autoriser.`);
        return this.toTerminal(room, { type: 'relance-demandee', requestId: room.requestId, by: login });
      case 'terminal': {
        if (!fromTerminal) return;
        const data = mask(String(message.data));
        room.terminal = (room.terminal + data).slice(-MAX_TERMINAL_CHARS);
        return this.broadcast(room, { type: 'terminal', requestId: room.requestId, data }, member);
      }
      case 'execution': {
        if (!fromTerminal) return;
        room.running = message.state === 'en-cours';
        if (!room.running) room.lastExitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
        if (room.running) room.terminal = '';
        return this.broadcast(room, { type: 'execution', requestId: room.requestId, state: room.running ? 'en-cours' : 'terminee', exitCode: room.lastExitCode });
      }
      case 'reponse': {
        if (!fromTerminal) return;
        const path = mask(String(message.path));
        const reason = message.reason ? ` (${mask(String(message.reason))})` : '';
        return this.say(room, 'SOS', 'systeme', message.accepted ? `✔ Correction appliquée sur la machine : ${path}` : `✗ Correction refusée : ${path}${reason}`);
      }
      case 'reponse-relance':
        if (!fromTerminal) return;
        return this.say(room, 'SOS', 'systeme', message.accepted ? 'Relance autorisée.' : 'Relance refusée par le demandeur.');
    }
  }

  async resolve(conn: SalleConnection, requestId: string): Promise<void> {
    const user = conn.user!;
    const room = this.rooms.get(requestId);
    if (!room || ![...room.members].some((m) => m.conn === conn)) return conn.send({ type: 'erreur', message: 'Rejoins la salle d’abord.' });
    if (!(await this.store.resolveRequest(requestId, user.id, this.now()))) return conn.send({ type: 'erreur', message: 'Cette salle est déjà fermée.' });
    this.logger.log(`Demande ${requestId.slice(0, 8)} résolue par ${user.login} : code effacé.`);
    this.end(requestId, 'resolue', user.login);
  }

  leave(conn: SalleConnection): void {
    for (const room of this.rooms.values()) {
      const before = room.members.size;
      for (const m of room.members) if (m.conn === conn) room.members.delete(m);
      if (room.members.size !== before) this.broadcastPresence(room);
    }
  }

  /** Closes the room for everyone (the requester cancelled, the request expired or was resolved). */
  end(requestId: string, raison: 'resolue' | 'annulee' | 'expiree', by?: string): void {
    const room = this.rooms.get(requestId);
    if (!room) return;
    this.rooms.delete(requestId);
    this.broadcast(room, { type: 'salle-fermee', requestId, raison, ...(by ? { by } : {}) });
    room.doc.destroy();
  }

  /** Rooms whose request expired (24 h) are closed: their code no longer exists on the server. */
  sweep(now = this.now()): void {
    for (const room of [...this.rooms.values()]) if (room.expiresAt <= now) this.end(room.requestId, 'expiree');
  }

  private async open(request: StoredRequest): Promise<Room> {
    const [requester, helper] = await Promise.all([this.store.getUser(request.userId), this.store.getUser(request.helperId!)]);
    // Another join may have opened it while we were waiting.
    const existing = this.rooms.get(request.id);
    if (existing) return existing;
    const doc = new Y.Doc();
    for (const file of request.payload.files) doc.getText(file.path).insert(0, file.content);
    const room: Room = {
      requestId: request.id,
      requester: publicUser(requester!),
      helper: publicUser(helper!),
      command: request.command,
      tech: request.tech,
      errorSummary: errorSummary(request.payload.output),
      files: request.payload.files.map((f) => ({ path: f.path, ...(f.line ? { line: f.line } : {}) })),
      doc,
      chat: [],
      terminal: request.payload.output,
      running: false,
      lastExitCode: request.exitCode,
      expiresAt: request.expiresAt,
      members: new Set(),
      nextMessageId: 1,
    };
    this.rooms.set(request.id, room);
    return room;
  }

  private stateOf(room: Room, role: SalleRole): SalleState {
    return {
      requestId: room.requestId,
      role,
      requester: room.requester,
      helper: room.helper,
      command: room.command,
      tech: room.tech,
      errorSummary: room.errorSummary,
      files: room.files,
      doc: toBase64(Y.encodeStateAsUpdate(room.doc)),
      chat: room.chat,
      terminal: room.terminal,
      running: room.running,
      lastExitCode: room.lastExitCode,
      members: this.membersOf(room),
      url: `${this.config.webUrl}/#/salle/${room.requestId}`,
      expiresAt: room.expiresAt.toISOString(),
    };
  }

  private say(room: Room, from: string, role: ChatMessage['role'], text: string): void {
    const trimmed = text.trim().slice(0, 4000);
    if (!trimmed) return;
    const message: ChatMessage = { id: room.nextMessageId++, from, role, text: trimmed, at: this.now().toISOString() };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT) room.chat.shift();
    this.broadcast(room, { type: 'message', requestId: room.requestId, message });
  }

  private membersOf(room: Room): SalleMember[] {
    const seen = new Map<string, SalleMember>();
    for (const m of room.members) {
      const member = { login: m.conn.user!.login, role: m.role, client: m.client };
      seen.set(`${member.login}/${member.client}`, member);
    }
    return [...seen.values()];
  }

  private terminalOnline(room: Room): boolean {
    return [...room.members].some((m) => m.client === 'terminal');
  }

  private toTerminal(room: Room, message: ServerMessage): void {
    for (const m of room.members) if (m.client === 'terminal') m.conn.send(message);
  }

  private broadcastPresence(room: Room): void {
    this.broadcast(room, { type: 'presence', requestId: room.requestId, members: this.membersOf(room) });
  }

  private broadcast(room: Room, message: ServerMessage, except?: Member): void {
    for (const m of room.members) if (m !== except) m.conn.send(message);
  }

  private docSize(room: Room): number {
    return room.files.reduce((n, f) => n + room.doc.getText(f.path).length, 0);
  }
}
