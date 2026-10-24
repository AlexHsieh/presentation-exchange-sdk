import { PresentationSdkError } from './errors.js';
import type { CredentialState, PresentationSubmissionErrorResponse } from './types.js';

/** Stable public codes for wallet submission responses, independent of diagnostic SDK codes. */
export const PresentationSubmissionErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_NOT_PENDING: 'SESSION_NOT_PENDING',
  REQUEST_MISMATCH: 'REQUEST_MISMATCH',
  INVALID_PRESENTATION: 'INVALID_PRESENTATION',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  CREDENTIAL_REVOKED: 'CREDENTIAL_REVOKED',
  CREDENTIAL_NOT_ACCEPTED: 'CREDENTIAL_NOT_ACCEPTED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type PresentationSubmissionErrorCode = typeof PresentationSubmissionErrorCode[keyof typeof PresentationSubmissionErrorCode];

const messages: Record<PresentationSubmissionErrorCode, string> = {
  INVALID_INPUT: 'Invalid request body.',
  SESSION_NOT_FOUND: 'Verification request not found.',
  SESSION_EXPIRED: 'Verification request has expired. Please start a new request.',
  SESSION_NOT_PENDING: 'Verification request is no longer pending. Please start a new request.',
  REQUEST_MISMATCH: 'Submission does not match the verification request.',
  INVALID_PRESENTATION: 'Presentation could not be verified.',
  CREDENTIAL_EXPIRED: 'Credential has expired.',
  CREDENTIAL_REVOKED: 'Credential has been revoked.',
  CREDENTIAL_NOT_ACCEPTED: 'Credential does not meet this application’s requirements.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  SERVICE_UNAVAILABLE: 'Verification is temporarily unavailable.',
  INTERNAL_ERROR: 'Submission could not be completed.',
};

export function isPresentationSubmissionErrorCode(code: string): code is PresentationSubmissionErrorCode {
  return Object.hasOwn(messages, code);
}

/** Uses public text only; never serializes diagnostic errors or credential attributes. */
export function createPresentationSubmissionError(
  code: PresentationSubmissionErrorCode,
  retry: { retryable?: boolean; retryAfterSeconds?: number | null } = {},
): PresentationSubmissionErrorResponse {
  return {
    ok: false,
    error: {
      code,
      message: messages[code],
      ...(retry.retryable !== undefined ? { retryable: retry.retryable } : {}),
      ...(retry.retryAfterSeconds !== undefined ? { retryAfterSeconds: retry.retryAfterSeconds } : {}),
    },
  };
}

export type PresentationSubmissionErrorClassification = { code: PresentationSubmissionErrorCode; status: number };

/** Unknown exceptions are server failures, never evidence of an invalid presentation. */
export function classifyPresentationSubmissionError(error: unknown): PresentationSubmissionErrorClassification {
  const C = PresentationSubmissionErrorCode;
  if (!(error instanceof PresentationSdkError)) return { code: C.INTERNAL_ERROR, status: 500 };
  switch (error.code) {
    case 'CREDENTIAL_EXPIRED': return { code: C.CREDENTIAL_EXPIRED, status: 422 };
    case 'CREDENTIAL_REVOKED': return { code: C.CREDENTIAL_REVOKED, status: 422 };
    case 'PRESENTATION_REQUEST_EXPIRED': return { code: C.SESSION_EXPIRED, status: 410 };
    case 'PRESENTATION_REQUEST_CONFLICT': return { code: C.REQUEST_MISMATCH, status: 409 };
    case 'PD_NONCE_MISMATCH': return { code: C.REQUEST_MISMATCH, status: 403 };
    case 'PD_HASH_MISMATCH':
      return error.details.source === 'stored'
        ? { code: C.INTERNAL_ERROR, status: 500 }
        : { code: C.REQUEST_MISMATCH, status: 403 };
    case 'VP_VERIFY_FAILED':
    case 'PRESENTATION_SUBMISSION_INVALID': return { code: C.INVALID_PRESENTATION, status: 422 };
    case 'CREDENTIAL_PROVIDER_INVALID':
    case 'TARGET_VC_TYPE_NOT_ALLOWED':
    case 'CREDENTIAL_STATUS_INVALID': return { code: C.CREDENTIAL_NOT_ACCEPTED, status: 422 };
    case 'APP_NOT_REGISTERED':
    case 'APP_NOT_ACTIVE':
    case 'REQUEST_ISSUER_NOT_TRUSTED':
    case 'STATUS_LIST_FETCH_FAILED':
    case 'STATUS_LIST_INVALID': return { code: C.SERVICE_UNAVAILABLE, status: 503 };
    default: return { code: C.INTERNAL_ERROR, status: 500 };
  }
}

/** Classifies the second status check without treating unknown state as a rejection. */
export function classifyPresentationCredentialState(state: CredentialState): PresentationSubmissionErrorClassification | undefined {
  const C = PresentationSubmissionErrorCode;
  if (state.expiration) return { code: C.CREDENTIAL_EXPIRED, status: 422 };
  if (state.revocation === 'revoked') return { code: C.CREDENTIAL_REVOKED, status: 422 };
  if (state.statusListLifecycle === 'sealing' || state.statusListLifecycle === 'sealed') {
    return { code: C.CREDENTIAL_NOT_ACCEPTED, status: 422 };
  }
  if (state.revocation !== 'not_revoked' || !['active', 'retired'].includes(state.statusListLifecycle)) {
    return { code: C.SERVICE_UNAVAILABLE, status: 503 };
  }
  return undefined;
}
