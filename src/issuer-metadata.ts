/** Public display metadata; never an issuer trust policy. */
export interface IssuerMetadata {
  did: string;
  name: string;
  description: string;
  iconUrl: string;
  websiteUrl: string;
  defaultLocale: 'en';
  localizations: { 'zh-Hant': { name: string; description: string } };
}
export interface FetchIssuerMetadataInput {
  did: string;
  registryBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
export class IssuerMetadataError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'FETCH_FAILED' | 'INVALID_RESPONSE', message: string, public readonly status?: number) {
    super(message); this.name = 'IssuerMetadataError';
  }
}
export function isIssuerDisplayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function isIssuerMetadata(value: unknown, did?: string): value is IssuerMetadata {
  if (!value || typeof value !== 'object') return false;
  const v = value as IssuerMetadata;
  const translation = v.localizations?.['zh-Hant'];
  return typeof v.did === 'string' && (!did || v.did === did) &&
    typeof v.name === 'string' && !!v.name.trim() && typeof v.description === 'string' && !!v.description.trim() &&
    isIssuerDisplayUrl(v.iconUrl) && isIssuerDisplayUrl(v.websiteUrl) && v.defaultLocale === 'en' &&
    !!translation && typeof translation.name === 'string' && !!translation.name.trim() &&
    typeof translation.description === 'string' && !!translation.description.trim();
}
export async function fetchIssuerMetadata(input: FetchIssuerMetadataInput): Promise<IssuerMetadata | null> {
  let url: URL;
  try {
    if (typeof input.did !== 'string' || input.did.length > 2048 || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(input.did)) throw new Error();
    url = new URL(input.registryBaseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, '') + '/api/v1/issuers';
    url.searchParams.set('did', input.did);
  } catch { throw new IssuerMetadataError('INVALID_INPUT', 'A valid DID and HTTPS registry base URL are required'); }
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) cancel();
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await (input.fetch ?? globalThis.fetch)(url.toString(), {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    let body;
    try { body = await response.json(); }
    catch { throw new IssuerMetadataError('INVALID_RESPONSE', 'Issuer response is not JSON', response.status); }
    if (response.status === 404 && body?.ok === false && body?.error?.code === 'ISSUER_NOT_FOUND') return null;
    if (!response.ok) throw new IssuerMetadataError('FETCH_FAILED', 'Issuer request failed', response.status);
    if (body?.ok !== true || !isIssuerMetadata(body.issuer, input.did)) throw new IssuerMetadataError('INVALID_RESPONSE', 'Invalid issuer metadata', response.status);
    const { did, name, description, iconUrl, websiteUrl, defaultLocale, localizations } = body.issuer;
    return { did, name, description, iconUrl, websiteUrl, defaultLocale, localizations };
  } catch (error) {
    if (error instanceof IssuerMetadataError) throw error;
    throw new IssuerMetadataError('FETCH_FAILED', 'Issuer request failed or was cancelled');
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); }
}
