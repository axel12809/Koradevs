import type { SosRequest } from '@sos/shared';

export type Provider = 'github' | 'dev';

export interface User {
  id: string;
  provider: Provider;
  providerId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

export type UserInput = Omit<User, 'id' | 'createdAt'>;

export type RequestStatus = 'ouverte' | 'acceptee' | 'resolue' | 'fermee';

export interface StoredRequest {
  id: string;
  userId: string;
  status: RequestStatus;
  tech: string[];
  command: string;
  exitCode: number;
  payload: SosRequest;
  helperId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewRequest {
  userId: string;
  payload: SosRequest;
  createdAt: Date;
  expiresAt: Date;
}

export interface Solution {
  id: string;
  title: string;
  error: string;
  cause: string;
  fix: string;
  tech: string[];
  createdAt: Date;
}

export type NewSolution = Omit<Solution, 'createdAt'>;

export interface PurgeResult {
  requests: number;
  sessions: number;
}

export interface Store {
  readonly kind: 'postgres' | 'memoire';
  upsertUser(input: UserInput): Promise<User>;
  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  findUserBySession(tokenHash: string, now: Date): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  createRequest(input: NewRequest): Promise<StoredRequest>;
  countRequestsSince(userId: string, since: Date): Promise<number>;
  /** Expired requests are invisible even before the purge runs. */
  getRequest(id: string, now: Date): Promise<StoredRequest | null>;
  listRequests(userId: string, now: Date): Promise<StoredRequest[]>;
  /** Open (not accepted, not closed, not expired) requests, oldest first. */
  listOpenRequests(now: Date): Promise<StoredRequest[]>;
  /** Atomic: only the first helper wins. Returns null if the request is no longer open. */
  acceptRequest(id: string, helperId: string, now: Date): Promise<StoredRequest | null>;
  /** Closes an open or accepted request of this user. Returns false if there was nothing to close. */
  closeRequest(id: string, userId: string): Promise<boolean>;
  /** « Problème résolu » by the requester or the helper of an accepted request: the code is erased now. */
  resolveRequest(id: string, userId: string, now: Date): Promise<boolean>;
  getUser(id: string): Promise<User | null>;
  setHelperTech(userId: string, tech: string[]): Promise<void>;
  getHelperTech(userId: string): Promise<string[]>;
  /** Inserts the sheets that do not exist yet (by id). */
  seedSolutions(solutions: NewSolution[]): Promise<void>;
  /** Sheets containing at least one of these lowercase words (scoring is done by the caller). */
  findSolutionCandidates(words: string[], limit: number): Promise<Solution[]>;
  purgeExpired(now: Date): Promise<PurgeResult>;
  close(): Promise<void>;
}
