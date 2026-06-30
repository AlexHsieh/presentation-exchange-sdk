import { StatusListCredential, VerifiableCredential } from '@web5/credentials';
import { sdkError } from './errors.js';
import type {
  StatusListCacheEntry,
  StatusListClientOptions,
  StatusListReference,
  StatusListResponseBody,
} from './types.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

type InternalStatusListCacheEntry = StatusListCacheEntry & {
  statusListCredentialInstance: VerifiableCredential;
  fetchedAtMs: number;
};

export class StatusListClient {
  private readonly cache = new Map<string, InternalStatusListCacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly statusListBaseUrl?: string;

  constructor(private readonly options: StatusListClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.statusListBaseUrl = options.statusListUrl ? normalizeBaseUrl(options.statusListUrl) : undefined;
  }

  buildStatusListUrl(statusId: string): string {
    if (!this.statusListBaseUrl) {
      throw sdkError('STATUS_LIST_URL_NOT_ALLOWED', 'statusListUrl is required to build status-list URLs');
    }
    const encoded = encodeURIComponent(statusId);
    return `${this.statusListBaseUrl.replace(/\/$/, '')}/${encoded}`;
  }

  async getStatusList(input: string | StatusListReference): Promise<StatusListCacheEntry> {
    const statusListUrl = typeof input === 'string' ? input : input.url;
    this.assertStatusListUrlAllowed(statusListUrl);

    const now = this.now();
    const nowMs = now.getTime();
    const existing = this.cache.get(statusListUrl);
    if (existing && !isCacheExpired(existing, nowMs, this.ttlMs)) {
      return toPublicEntry(existing);
    }

    const headers: Record<string, string> = {};
    if (existing?.etag) headers['If-None-Match'] = existing.etag;
    if (existing?.lastModified) headers['If-Modified-Since'] = existing.lastModified;

    let response: Response;
    try {
      response = await this.fetchImpl(statusListUrl, { headers });
    } catch (error) {
      throw sdkError('STATUS_LIST_FETCH_FAILED', 'Status list fetch failed', {
        statusListUrl,
        cause: messageFrom(error),
      });
    }

    if (response.status === 304 && existing) {
      const refreshed = { ...existing, fetchedAt: now, fetchedAtMs: nowMs };
      this.cache.set(statusListUrl, refreshed);
      return toPublicEntry(refreshed);
    }
    if (!response.ok) {
      throw sdkError('STATUS_LIST_FETCH_FAILED', 'Status list fetch failed', {
        statusListUrl,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const payload = await parseStatusListPayload(response, statusListUrl);
    const statusListCredentialInstance = await parseAndVerifyStatusListCredential(payload.statusListJwt, statusListUrl);
    const entry: InternalStatusListCacheEntry = {
      statusListUrl,
      statusListJwt: payload.statusListJwt,
      statusListCredential: statusListCredentialInstance.vcDataModel as unknown as Record<string, unknown>,
      statusListCredentialInstance,
      fetchedAt: now,
      fetchedAtMs: nowMs,
      updatedAt: payload.updatedAt,
      nextCheckAt: payload.nextCheckAt,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    };

    this.cache.set(statusListUrl, entry);
    await this.options.store?.save(toPublicEntry(entry));
    return toPublicEntry(entry);
  }

  async verifyCredentialStatus(input: { credentialJwt: string; statusList?: StatusListReference }): Promise<boolean> {
    if (!input.statusList?.url) {
      return true;
    }
    const entry = await this.getStatusList(input.statusList);
    const credential = parseCredentialJwt(input.credentialJwt);
    const cached = this.cache.get(entry.statusListUrl);
    const statusListCredential = cached?.statusListCredentialInstance ?? VerifiableCredential.parseJwt({ vcJwt: entry.statusListJwt });
    const revoked = StatusListCredential.validateCredentialInStatusList(credential, statusListCredential);
    return !revoked;
  }

  assertStatusListUrlAllowed(statusListUrl: string): void {
    if (!this.statusListBaseUrl) {
      return;
    }
    let candidate: URL;
    let base: URL;
    try {
      candidate = new URL(statusListUrl);
      base = new URL(this.statusListBaseUrl);
    } catch {
      throw sdkError('STATUS_LIST_URL_NOT_ALLOWED', 'Status list URL is invalid', { statusListUrl });
    }

    const basePath = base.pathname.replace(/\/$/, '');
    const candidatePath = candidate.pathname.replace(/\/$/, '');
    const sameOrigin = candidate.protocol === base.protocol && candidate.host === base.host;
    const underPath = candidatePath === basePath || candidatePath.startsWith(`${basePath}/`);
    if (!sameOrigin || !underPath) {
      throw sdkError('STATUS_LIST_URL_NOT_ALLOWED', 'Status list URL is outside the configured statusListUrl base', {
        statusListUrl,
        allowedBaseUrl: this.statusListBaseUrl,
      });
    }
  }
}

export async function getStatusList(
  input: string | StatusListReference,
  options: StatusListClientOptions = {},
): Promise<StatusListCacheEntry> {
  return new StatusListClient(options).getStatusList(input);
}

export async function verifyCredentialStatus(
  input: { credentialJwt: string; statusList?: StatusListReference },
  options: StatusListClientOptions = {},
): Promise<boolean> {
  return new StatusListClient(options).verifyCredentialStatus(input);
}

function isCacheExpired(entry: InternalStatusListCacheEntry, nowMs: number, ttlMs: number): boolean {
  if (entry.nextCheckAt) {
    const nextCheckAt = Date.parse(entry.nextCheckAt);
    if (!Number.isNaN(nextCheckAt)) {
      return nowMs >= nextCheckAt;
    }
  }
  return nowMs - entry.fetchedAtMs >= ttlMs;
}

async function parseStatusListPayload(response: Response, statusListUrl: string): Promise<StatusListResponseBody> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw sdkError('STATUS_LIST_INVALID', 'Status list response is not valid JSON', {
      statusListUrl,
      cause: messageFrom(error),
    });
  }
  if (!payload || typeof payload !== 'object' || typeof (payload as StatusListResponseBody).statusListJwt !== 'string') {
    throw sdkError('STATUS_LIST_INVALID', 'Status list response missing statusListJwt', { statusListUrl });
  }
  return payload as StatusListResponseBody;
}

async function parseAndVerifyStatusListCredential(statusListJwt: string, statusListUrl: string): Promise<VerifiableCredential> {
  try {
    await VerifiableCredential.verify({ vcJwt: statusListJwt });
    return VerifiableCredential.parseJwt({ vcJwt: statusListJwt });
  } catch (error) {
    throw sdkError('STATUS_LIST_INVALID', 'Status list credential verification failed', {
      statusListUrl,
      cause: messageFrom(error),
    });
  }
}

function parseCredentialJwt(credentialJwt: string): VerifiableCredential {
  try {
    return VerifiableCredential.parseJwt({ vcJwt: credentialJwt });
  } catch (error) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Unable to parse credential JWT', { cause: messageFrom(error) });
  }
}

function toPublicEntry(entry: InternalStatusListCacheEntry): StatusListCacheEntry {
  return {
    statusListUrl: entry.statusListUrl,
    statusListJwt: entry.statusListJwt,
    statusListCredential: entry.statusListCredential,
    fetchedAt: entry.fetchedAt,
    updatedAt: entry.updatedAt,
    nextCheckAt: entry.nextCheckAt,
    etag: entry.etag,
    lastModified: entry.lastModified,
  };
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, '');
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
