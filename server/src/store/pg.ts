import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SosRequest } from '@sos/shared';
import type { NewRequest, NewSolution, Provider, PurgeResult, RequestStatus, Solution, Store, StoredRequest, User, UserInput } from './types.js';

interface UserRow {
  id: string;
  provider: Provider;
  provider_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
}

interface RequestRow {
  id: string;
  user_id: string;
  status: RequestStatus;
  tech: string[];
  command: string;
  exit_code: number;
  payload: SosRequest;
  helper_id: string | null;
  accepted_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

interface SolutionRow {
  id: string;
  title: string;
  error: string;
  cause: string;
  fix: string;
  tech: string[];
  created_at: Date;
}

const toSolution = (row: SolutionRow): Solution => ({
  id: row.id,
  title: row.title,
  error: row.error,
  cause: row.cause,
  fix: row.fix,
  tech: row.tech,
  createdAt: row.created_at,
});

const toUser = (row: UserRow): User => ({
  id: row.id,
  provider: row.provider,
  providerId: row.provider_id,
  login: row.login,
  name: row.name,
  avatarUrl: row.avatar_url,
  createdAt: row.created_at,
});

const toRequest = (row: RequestRow): StoredRequest => ({
  id: row.id,
  userId: row.user_id,
  status: row.status,
  tech: row.tech,
  command: row.command,
  exitCode: row.exit_code,
  payload: row.payload,
  helperId: row.helper_id,
  acceptedAt: row.accepted_at,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export class PgStore implements Store {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  async upsertUser(input: UserInput): Promise<User> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (id, provider, provider_id, login, name, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_id)
       DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [randomUUID(), input.provider, input.providerId, input.login, input.name, input.avatarUrl],
    );
    return toUser(rows[0]!);
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  }

  async findUserBySession(tokenHash: string, now: Date): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [tokenHash, now],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async createRequest(input: NewRequest): Promise<StoredRequest> {
    const { payload } = input;
    const { rows } = await this.pool.query<RequestRow>(
      `INSERT INTO requests (id, user_id, tech, command, exit_code, payload, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [randomUUID(), input.userId, payload.tech, payload.command, payload.exitCode, JSON.stringify(payload), input.createdAt, input.expiresAt],
    );
    return toRequest(rows[0]!);
  }

  async countRequestsSince(userId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*) FROM requests WHERE user_id = $1 AND created_at >= $2',
      [userId, since],
    );
    return Number(rows[0]!.count);
  }

  async getRequest(id: string, now: Date): Promise<StoredRequest | null> {
    const { rows } = await this.pool.query<RequestRow>('SELECT * FROM requests WHERE id = $1 AND expires_at > $2', [id, now]);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async listRequests(userId: string, now: Date): Promise<StoredRequest[]> {
    const { rows } = await this.pool.query<RequestRow>(
      'SELECT * FROM requests WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC',
      [userId, now],
    );
    return rows.map(toRequest);
  }

  async listOpenRequests(now: Date): Promise<StoredRequest[]> {
    const { rows } = await this.pool.query<RequestRow>(
      "SELECT * FROM requests WHERE status = 'ouverte' AND expires_at > $1 ORDER BY created_at",
      [now],
    );
    return rows.map(toRequest);
  }

  async acceptRequest(id: string, helperId: string, now: Date): Promise<StoredRequest | null> {
    const { rows } = await this.pool.query<RequestRow>(
      `UPDATE requests SET status = 'acceptee', helper_id = $2, accepted_at = $3
       WHERE id = $1 AND status = 'ouverte' AND expires_at > $3 AND user_id <> $2
       RETURNING *`,
      [id, helperId, now],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async closeRequest(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE requests SET status = 'fermee' WHERE id = $1 AND user_id = $2 AND status <> 'fermee'",
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveRequest(id: string, userId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE requests SET status = 'resolue', resolved_at = $3, expires_at = $3
       WHERE id = $1 AND status = 'acceptee' AND expires_at > $3 AND (user_id = $2 OR helper_id = $2)`,
      [id, userId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async setHelperTech(userId: string, tech: string[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO helper_profiles (user_id, tech) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET tech = EXCLUDED.tech, updated_at = now()`,
      [userId, tech],
    );
  }

  async getHelperTech(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ tech: string[] }>('SELECT tech FROM helper_profiles WHERE user_id = $1', [userId]);
    return rows[0]?.tech ?? [];
  }

  async seedSolutions(solutions: NewSolution[]): Promise<void> {
    for (const s of solutions) {
      await this.pool.query(
        `INSERT INTO solutions (id, title, error, cause, fix, tech) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.title, s.error, s.cause, s.fix, s.tech],
      );
    }
  }

  async findSolutionCandidates(words: string[], limit: number): Promise<Solution[]> {
    const terms = words.filter((w) => /^[\p{L}\p{N}_]+$/u.test(w));
    if (!terms.length) return [];
    const { rows } = await this.pool.query<SolutionRow>(
      `SELECT id, title, error, cause, fix, tech, created_at FROM solutions
       WHERE search @@ to_tsquery('simple', $1)
       ORDER BY ts_rank(search, to_tsquery('simple', $1)) DESC
       LIMIT $2`,
      [terms.join(' | '), limit],
    );
    return rows.map(toSolution);
  }

  async purgeExpired(now: Date): Promise<PurgeResult> {
    const requests = await this.pool.query('DELETE FROM requests WHERE expires_at <= $1', [now]);
    const sessions = await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    return { requests: requests.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
