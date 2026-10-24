import { describe, it, expect } from 'vitest';
import { PresentationSdkError, PresentationSubmissionErrorCode as C, createPresentationSubmissionError, classifyPresentationSubmissionError, classifyPresentationCredentialState } from '../src/index.js';

describe('public submission errors', () => {
  it('exports safe responses for all shared codes and preserves retry metadata', () => {
    expect(Object.keys(C)).toHaveLength(12);
    for (const code of Object.values(C)) {
      const body = createPresentationSubmissionError(code, { retryable: false, retryAfterSeconds: 30 });
      expect(body).toMatchObject({ ok: false, error: { code, message: expect.any(String), retryable: false, retryAfterSeconds: 30 } });
      expect(body.error).not.toHaveProperty('reason');
      expect(body.error).not.toHaveProperty('details');
    }
  });
  it.each([
    ['STATUS_LIST_FETCH_FAILED', C.SERVICE_UNAVAILABLE, 503], ['STATUS_LIST_INVALID', C.SERVICE_UNAVAILABLE, 503],
    ['CREDENTIAL_EXPIRED', C.CREDENTIAL_EXPIRED, 422], ['CREDENTIAL_REVOKED', C.CREDENTIAL_REVOKED, 422],
    ['PRESENTATION_REQUEST_EXPIRED', C.SESSION_EXPIRED, 410], ['PD_HASH_MISMATCH', C.REQUEST_MISMATCH, 403],
    ['PD_NONCE_MISMATCH', C.REQUEST_MISMATCH, 403], ['PRESENTATION_REQUEST_CONFLICT', C.REQUEST_MISMATCH, 409],
    ['VP_VERIFY_FAILED', C.INVALID_PRESENTATION, 422], ['CREDENTIAL_PROVIDER_INVALID', C.CREDENTIAL_NOT_ACCEPTED, 422],
  ] as const)('maps %s without exposing details', (diagnostic, code, status) => {
    const result = classifyPresentationSubmissionError(new PresentationSdkError(diagnostic, 'private message', { credentialJwt: 'private' }));
    expect(result).toEqual({ code, status });
    expect(JSON.stringify(createPresentationSubmissionError(result.code))).not.toContain('private');
  });
  it('keeps unknown exceptions and broken stored state separate from user mismatch', () => {
    expect(classifyPresentationSubmissionError(new Error('private database error'))).toEqual({ code: C.INTERNAL_ERROR, status: 500 });
    expect(classifyPresentationSubmissionError(new PresentationSdkError('PD_HASH_MISMATCH', 'private', { source: 'stored' }))).toEqual({ code: C.INTERNAL_ERROR, status: 500 });
  });
  it('distinguishes credential state rejection from unavailable checks', () => {
    const state = { expiration: false, revocation: 'not_revoked' as const, statusListLifecycle: 'active' as const, checkedAt: new Date().toISOString() };
    expect(classifyPresentationCredentialState(state)).toBeUndefined();
    expect(classifyPresentationCredentialState({ ...state, expiration: true })?.code).toBe(C.CREDENTIAL_EXPIRED);
    expect(classifyPresentationCredentialState({ ...state, revocation: 'revoked' })?.code).toBe(C.CREDENTIAL_REVOKED);
    expect(classifyPresentationCredentialState({ ...state, statusListLifecycle: 'sealed' })?.code).toBe(C.CREDENTIAL_NOT_ACCEPTED);
    expect(classifyPresentationCredentialState({ ...state, revocation: 'unknown' })).toEqual({ code: C.SERVICE_UNAVAILABLE, status: 503 });
  });
});
