import type { SosRequest } from './request.js';

export interface PublicUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  provider: 'github' | 'dev';
}

export interface SessionResponse {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export interface AuthConfigResponse {
  /** OAuth App client id used by `sos login` (GitHub device flow). */
  githubClientId: string | null;
  devAuth: boolean;
}

/** resolue : the room ended with « Problème résolu » (the code is erased at that moment). */
export type RequestStatus = 'ouverte' | 'acceptee' | 'resolue' | 'fermee';

export interface RequestSummary {
  id: string;
  status: RequestStatus;
  tech: string[];
  command: string;
  exitCode: number;
  files: number;
  createdAt: string;
  /** The code is erased from the server at this date. */
  expiresAt: string;
}

export interface CreatedRequest extends RequestSummary {
  secretsMasked: number;
  /** Secrets the server caught that the CLI had missed. */
  secondPassMasked: number;
}

export interface RequestDetail extends RequestSummary {
  request: SosRequest;
}

/** A published solution sheet matching an error. */
export interface SolutionHit {
  id: string;
  title: string;
  error: string;
  cause: string;
  fix: string;
  tech: string[];
  /** 0..1 : share of the error's words found in the sheet. */
  score: number;
}

/** ciblee : helpers of the same tech · elargie : close techs (after 2 min) · publique : everyone (after 5 min). */
export type RadarStage = 'ciblee' | 'elargie' | 'publique';

export interface RadarAlert {
  requestId: string;
  tech: string[];
  command: string;
  errorSummary: string;
  files: number;
  stage: RadarStage;
  requester: string;
  createdAt: string;
}

/** WebSocket `/ws`, browser → server. The first message must be `auth`. */
export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'disponible'; tech: string[] }
  | { type: 'pause' }
  | { type: 'suivre'; requestId: string }
  | { type: 'accepter'; requestId: string }
  // Salle SOS : only the requester and the helper of an accepted request.
  | { type: 'rejoindre'; requestId: string; client: SalleClient }
  | { type: 'yjs'; requestId: string; update: string }
  | { type: 'message'; requestId: string; text: string }
  | { type: 'proposer'; requestId: string }
  | { type: 'relance'; requestId: string }
  | { type: 'resolu'; requestId: string }
  // Sent by the requester's terminal only.
  | { type: 'terminal'; requestId: string; data: string }
  | { type: 'execution'; requestId: string; state: 'en-cours' | 'terminee'; exitCode?: number }
  | { type: 'reponse'; requestId: string; path: string; accepted: boolean; reason?: string }
  | { type: 'reponse-relance'; requestId: string; accepted: boolean };

export type ServerMessage =
  | { type: 'bienvenue'; user: PublicUser }
  | { type: 'alerte'; alert: RadarAlert }
  | { type: 'retirer'; requestId: string; raison: 'prise' | 'fermee' | 'expiree' }
  | { type: 'statut'; requestId: string; stage: RadarStage; alerted: number; online: number }
  | { type: 'acceptee'; requestId: string; helper: PublicUser }
  | { type: 'prise'; requestId: string; requester: PublicUser }
  | { type: 'fermee'; requestId: string }
  | { type: 'erreur'; message: string }
  | { type: 'salle'; salle: SalleState }
  | { type: 'yjs'; requestId: string; update: string }
  | { type: 'message'; requestId: string; message: ChatMessage }
  | { type: 'terminal'; requestId: string; data: string }
  | { type: 'execution'; requestId: string; state: 'en-cours' | 'terminee'; exitCode: number | null }
  | { type: 'presence'; requestId: string; members: SalleMember[] }
  | { type: 'proposition'; requestId: string; by: string }
  | { type: 'relance-demandee'; requestId: string; by: string }
  | { type: 'salle-fermee'; requestId: string; raison: 'resolue' | 'annulee' | 'expiree'; by?: string };

/** `terminal` = the `sos` command on the requester's machine; `web` = the browser. */
export type SalleClient = 'terminal' | 'web';
export type SalleRole = 'demandeur' | 'aidant';

export interface SalleMember {
  login: string;
  role: SalleRole;
  client: SalleClient;
}

/** `systeme` messages are written by the server (corrections accepted, relaunches…). */
export interface ChatMessage {
  id: number;
  from: string;
  role: SalleRole | 'systeme';
  text: string;
  at: string;
}

export interface SalleFile {
  path: string;
  line?: number;
}

export interface SalleState {
  requestId: string;
  role: SalleRole;
  requester: PublicUser;
  helper: PublicUser;
  command: string;
  tech: string[];
  errorSummary: string;
  /** Shared files: one Y.Text per path in the Yjs document. */
  files: SalleFile[];
  /** Full Yjs document (base64). Clients must start from a fresh Y.Doc. */
  doc: string;
  chat: ChatMessage[];
  /** Terminal output shown read-only in the room (already masked). */
  terminal: string;
  running: boolean;
  lastExitCode: number | null;
  members: SalleMember[];
  /** Web page of the room. */
  url: string;
  expiresAt: string;
}
