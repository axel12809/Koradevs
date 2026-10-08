import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, PayloadTooLargeException, BadRequestException } from '@nestjs/common';
import ignoreModule from 'ignore';
import {
  LIMITS,
  SENSITIVE_PATTERNS,
  SosRequestSchema,
  maskSecrets,
  type CreatedRequest,
  type RequestDetail,
  type RequestSummary,
  type SosRequest,
} from '@sos/shared';
import type { AppConfig } from '../config.js';
import type { Store, StoredRequest, User } from '../store/types.js';
import { CLOCK, CONFIG, STORE, type Clock } from '../tokens.js';
import { RadarService } from '../radar/radar.service.js';
import { SalleService } from '../salle/salle.service.js';
import { parseBody } from '../validation.js';

const ignore = ignoreModule.default;
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summary = (r: StoredRequest): RequestSummary => ({
  id: r.id,
  status: r.status,
  tech: r.tech,
  command: r.command,
  exitCode: r.exitCode,
  files: r.payload.files.length,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
});

/** Second masking pass on the server, in case the CLI was outdated or bypassed. */
export function remask(request: SosRequest): { request: SosRequest; extra: number } {
  let extra = 0;
  const mask = (text: string) => {
    const result = maskSecrets(text);
    extra += result.findings.length;
    return { text: result.text, count: result.findings.length };
  };
  const files = request.files.map((file) => {
    const masked = mask(file.content);
    return { ...file, content: masked.text, secretsMasked: file.secretsMasked + masked.count };
  });
  const command = mask(request.command).text;
  const output = mask(request.output).text;
  return { request: { ...request, command, output, files, secretsMasked: request.secretsMasked + extra }, extra };
}

@Injectable()
export class RequestsService {
  private readonly sensitive = ignore().add(SENSITIVE_PATTERNS);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(RadarService) private readonly radar: RadarService,
    @Inject(SalleService) private readonly salle: SalleService,
  ) {}

  async create(user: User, body: unknown): Promise<CreatedRequest> {
    const parsed = parseBody(SosRequestSchema, body);

    const refused = parsed.files.flatMap((f) => {
      const problem = this.pathProblem(f.path);
      return problem ? [`${f.path} (${problem})`] : [];
    });
    if (refused.length) throw new BadRequestException(`Fichiers refusés : ${refused.join(', ')}`);

    const total = parsed.files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
    if (total > LIMITS.maxTotalBytes) {
      throw new PayloadTooLargeException(`Fichiers trop lourds : ${total} o (maximum ${LIMITS.maxTotalBytes} o).`);
    }

    const now = this.now();
    const recent = await this.store.countRequestsSince(user.id, new Date(now.getTime() - HOUR));
    if (recent >= this.config.maxRequestsPerHour) {
      throw new HttpException(
        `Limite atteinte : ${this.config.maxRequestsPerHour} demandes par heure. Réessaie un peu plus tard.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { request, extra } = remask(parsed);
    const stored = await this.store.createRequest({
      userId: user.id,
      payload: request,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.requestTtlHours * HOUR),
    });
    await this.radar.tick();
    return { ...summary(stored), secretsMasked: request.secretsMasked, secondPassMasked: extra };
  }

  /** The requester gives up (or solved it alone): helpers stop seeing the request. */
  async close(user: User, id: string): Promise<void> {
    const stored = UUID.test(id) ? await this.store.getRequest(id, this.now()) : null;
    if (!stored) throw new NotFoundException('Demande introuvable, ou déjà effacée.');
    if (stored.userId !== user.id) throw new ForbiddenException('Cette demande ne t’appartient pas.');
    await this.store.closeRequest(id, user.id);
    this.salle.end(id, 'annulee', user.login);
    await this.radar.tick();
  }

  async list(user: User): Promise<RequestSummary[]> {
    return (await this.store.listRequests(user.id, this.now())).map(summary);
  }

  async get(user: User, id: string): Promise<RequestDetail> {
    const stored = UUID.test(id) ? await this.store.getRequest(id, this.now()) : null;
    if (!stored) throw new NotFoundException('Demande introuvable, ou déjà effacée.');
    if (stored.userId !== user.id) throw new ForbiddenException('Cette demande ne t’appartient pas.');
    return { ...summary(stored), request: stored.payload };
  }

  private pathProblem(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      return 'hors du projet';
    }
    const relative = normalized.replace(/^(\.\/)+/, '');
    if (!relative) return 'chemin vide';
    if (this.sensitive.ignores(relative)) return 'fichier sensible';
    return null;
  }
}
