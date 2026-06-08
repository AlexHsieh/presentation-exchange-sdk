export type PresentationSdkErrorCode =
  | 'APP_NOT_REGISTERED'
  | 'APP_NOT_ACTIVE'
  | 'REQUEST_ISSUER_NOT_TRUSTED'
  | 'REQUEST_TYPE_NOT_ALLOWED'
  | 'TARGET_VC_TYPE_NOT_ALLOWED'
  | 'POLICY_VALUE_NOT_ALLOWED'
  | 'ATTRIBUTE_NOT_ALLOWED'
  | 'ATTRIBUTE_SOURCE_NOT_ALLOWED'
  | 'PD_PATH_NOT_ALLOWED'
  | 'PD_FETCH_DOMAIN_NOT_ALLOWED'
  | 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED'
  | 'PRESENTATION_DEFINITION_INVALID'
  | 'PRESENTATION_REQUEST_EXPIRED'
  | 'PRESENTATION_REQUEST_CONFLICT'
  | 'PD_HASH_MISMATCH'
  | 'PD_NONCE_MISMATCH'
  | 'VP_VERIFY_FAILED'
  | 'PRESENTATION_SUBMISSION_INVALID'
  | 'CREDENTIAL_PROVIDER_INVALID'
  | 'CREDENTIAL_STATUS_INVALID';

export type PresentationSdkErrorShape = {
  code: PresentationSdkErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export class PresentationSdkError extends Error {
  readonly code: PresentationSdkErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PresentationSdkErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PresentationSdkError';
    this.code = code;
    this.details = details;
  }

  toJSON(): PresentationSdkErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

export function sdkError(
  code: PresentationSdkErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): PresentationSdkError {
  return new PresentationSdkError(code, message, details);
}
