import { describe, it, expect, vi } from 'vitest';
import { fetchIssuerMetadata } from '../src/issuer-metadata';
const issuer = { did: 'did:example:issuer', environment: 'stage', name: 'I Am Human', description: 'Description', iconUrl: 'https://firebasestorage.googleapis.com/icon?token=public', websiteUrl: 'https://stage.iamhuman.link', defaultLocale: 'en', localizations: { 'zh-Hant': { name: 'I Am Human', description: '中文' } } };
const input = { did: issuer.did, registryBaseUrl: 'https://example.com/appregistry' };
describe('public issuer metadata', () => {
 it('preserves base paths, encodes DID and leaves Firebase URL unchanged', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, issuer }));
  expect(await fetchIssuerMetadata({ ...input, fetch })).toEqual(issuer);
  const [url, options] = fetch.mock.calls[0];
  expect(new URL(url).pathname).toBe('/appregistry/api/v1/issuers');
  expect(new URL(url).searchParams.get('did')).toBe(issuer.did);
  expect(options.credentials).toBe('omit');
 });
 it('returns null only for an explicit unknown issuer', async () => {
  expect(await fetchIssuerMetadata({ ...input, fetch: vi.fn().mockResolvedValue(Response.json({ok:false,error:{code:'ISSUER_NOT_FOUND'}},{status:404})) })).toBeNull();
  await expect(fetchIssuerMetadata({ ...input, fetch: vi.fn().mockResolvedValue(Response.json({}, {status:404})) })).rejects.toMatchObject({code:'FETCH_FAILED'});
 });
 it.each([{ ...issuer, did:'did:example:other' }, { ...issuer, iconUrl:'javascript:alert(1)' }, { ...issuer, websiteUrl:'http://example.com' }, { ...issuer, localizations:{} }])('rejects unsafe or mismatched data', async bad => {
  await expect(fetchIssuerMetadata({ ...input, fetch: vi.fn().mockResolvedValue(Response.json({ok:true,issuer:bad})) })).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 });
 it('rejects unsafe API URLs and propagates network errors', async () => {
  await expect(fetchIssuerMetadata({...input,registryBaseUrl:'http://example.com'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(fetchIssuerMetadata({...input,fetch:vi.fn().mockRejectedValue(new Error())})).rejects.toMatchObject({code:'FETCH_FAILED'});
 });
 it('cancels on timeout and caller abort', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url, options) => new Promise<Response>((_resolve,reject) => {
   if (options.signal.aborted) reject(new Error('abort'));
   else options.signal.addEventListener('abort', () => reject(new Error('abort')));
  })) as unknown as typeof globalThis.fetch;
  const pending = expect(fetchIssuerMetadata({...input,fetch})).rejects.toMatchObject({code:'FETCH_FAILED'});
  await vi.advanceTimersByTimeAsync(5000); await pending; vi.useRealTimers();
  const controller=new AbortController(); controller.abort();
  await expect(fetchIssuerMetadata({...input,fetch,signal:controller.signal})).rejects.toMatchObject({code:'FETCH_FAILED'});
 });
});
