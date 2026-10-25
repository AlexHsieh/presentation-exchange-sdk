import type { PresentationDefinitionV2 } from '@web5/credentials';
import type { PersonalDataSource, PolicyTier, TargetCredentialType } from './constants.js';

export type PolicyTierValue = (typeof PolicyTier)[keyof typeof PolicyTier];
export type PersonalDataSourceValue = (typeof PersonalDataSource)[keyof typeof PersonalDataSource];
export type TargetCredentialTypeValue = (typeof TargetCredentialType)[keyof typeof TargetCredentialType];
export type AppStatus = 'draft' | 'testing' | 'active' | 'suspended' | 'revoked';
export type PresentationRequestMode = 'configDriven' | 'developerDefined';
export type PresentationDefinitionRegistryField = 'name' | 'purpose';

export type SemanticAttribute =
  | 'type'
  | 'expirationDate'
  | 'issuanceDate'
  | 'subjectId'
  | 'pdRequestType'
  | 'personalDataSource'
  | 'name'
  | 'profilePicture'
  | 'profileUrl'
  | 'socialMedia'
  | 'nationality';

export interface PresentationPolicy {
  tier: PolicyTierValue;
  personalDataSource: PersonalDataSourceValue;
}

export interface TargetCredentialPolicyConfig {
  personalDataSource: PersonalDataSourceValue;
  attributes?: AttributeInput;
}

export interface TargetCredentialCapabilityConfig {
  allowedPersonalDataSources: PersonalDataSourceValue[];
  allowedAttributes?: AttributeInput;
}

interface RequestCredentialTypeConfigBase {
  type: string;
  description?: string;
  targetCredentialType: TargetCredentialTypeValue[];
}

export interface ConfigDrivenRequestCredentialTypeConfig extends RequestCredentialTypeConfigBase {
  presentationRequestMode: 'configDriven';
  targetCredentialPolicies: Partial<Record<TargetCredentialTypeValue, TargetCredentialPolicyConfig>>;
  targetCredentialCapabilities?: never;
}

export interface DeveloperDefinedRequestCredentialTypeConfig extends RequestCredentialTypeConfigBase {
  presentationRequestMode: 'developerDefined';
  targetCredentialCapabilities: Partial<Record<TargetCredentialTypeValue, TargetCredentialCapabilityConfig>>;
  targetCredentialPolicies?: never;
}

export type RequestCredentialTypeConfig =
  | ConfigDrivenRequestCredentialTypeConfig
  | DeveloperDefinedRequestCredentialTypeConfig;

export interface PresentationScopeConfig {
  scopeId: string;
  title: string;
  iconUrl?: string;
  requestCredentialTypes: RequestCredentialTypeConfig[];
}

export interface PresentationAppConfig {
  appId: string;
  tenantId: string;
  appDid: string;
  scopes: PresentationScopeConfig[];
  allowedOrigin: string;
  allowedPdFetchDomain: string;
  allowedVcSubmissionDomain: string;
  allowedTargetCredentialTypes: TargetCredentialTypeValue[];
  allowedPresentationPaths: string[];
  acceptedCredentialProviders: string[];
  statusListUrl?: string;
  status: AppStatus;
  version: string;
  [key: string]: unknown;
}

export type StatusListReference = {
  index: number;
  url: string;
  credentialId?: string;
};

export interface RequestIssuerDid {
  uri: string;
  document: {
    id: string;
    verificationMethod: Array<{
      id: string;
      type: 'JsonWebKey2020' | string;
      controller: string;
      publicKeyJwk: Record<string, unknown>;
    }>;
    assertionMethod?: string[];
    authentication?: string[];
    [key: string]: unknown;
  };
  privateKeys: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CredentialStatusVerificationInput = {
  statusList?: StatusListReference;
  credentialJwt: string;
  credentialSubject: Record<string, unknown>;
};

export type CredentialStatusVerifier = (input: CredentialStatusVerificationInput) => Promise<boolean> | boolean;

export type StatusListLifecycle = 'active' | 'retired' | 'sealing' | 'sealed' | 'unknown';
export type KnownStatusListLifecycle = Exclude<StatusListLifecycle, 'unknown'>;

export type StatusListResponseBody = {
  statusListJwt: string;
  updatedAt?: string;
  nextCheckAt?: string | null;
  lifecycleStatus?: KnownStatusListLifecycle;
  mutable?: boolean;
};

export type StatusListCacheEntry = {
  statusListUrl: string;
  statusListJwt: string;
  statusListCredential: Record<string, unknown>;
  fetchedAt: Date;
  updatedAt?: string;
  nextCheckAt?: string | null;
  lifecycleStatus?: KnownStatusListLifecycle;
  mutable?: boolean;
  etag?: string;
  lastModified?: string;
};

export interface StatusListStore {
  save(entry: StatusListCacheEntry): Promise<void> | void;
}

export interface StatusListClientOptions {
  statusListUrl?: string;
  ttlMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  store?: StatusListStore;
}

export interface VerifyCredentialInput {
  credentialJwt: string;
  expectedTargetCredentialType?: TargetCredentialTypeValue;
  acceptedProviderDids?: string[];
  /** Whether a credentialStatus reference must be present and usable. */
  credentialStatusPolicy?: 'required' | 'ifPresent';
}

export type CredentialValidityInvalidReason =
  | 'malformed'
  | 'signature_invalid'
  | 'dates_invalid'
  | 'not_yet_valid'
  | 'expired'
  | 'issuer_not_allowed'
  | 'type_not_allowed'
  | 'unsupported_type'
  | 'status_required'
  | 'revoked'
  | 'status_rejected'
  | 'status_reference_not_allowed';

export type CredentialValidityIndeterminateReason =
  | 'status_list_unavailable'
  | 'status_list_invalid'
  | 'status_check_failed';

export type CredentialValidityResult =
  | {
      status: 'valid';
      credential: VerifiedCredential;
      checkedAt: string;
    }
  | {
      status: 'invalid';
      reason: CredentialValidityInvalidReason;
      checkedAt: string;
      details?: Record<string, unknown>;
    }
  | {
      status: 'indeterminate';
      reason: CredentialValidityIndeterminateReason;
      checkedAt: string;
      retryable: true;
      details?: Record<string, unknown>;
    };

export type CredentialState = {
  expiration: boolean;
  revocation: 'not_revoked' | 'revoked' | 'unknown';
  statusListLifecycle: StatusListLifecycle;
  checkedAt: string;
};

export interface VerifiedCredential {
  issuerDid: string;
  credentialJwt: string;
  credentialTypes: string[];
  credentialTier: PolicyTierValue;
  credentialSubject: Record<string, unknown>;
  issuanceDate: string;
  expirationDate: string;
  statusList?: StatusListReference;
  normalized: {
    name?: string;
    profilePicture?: string;
    profileUrl?: string;
    socialMedia?: string[];
    nationality?: string[];
  };
}

export interface PresentationServiceOptions {
  appConfig: PresentationAppConfig;
  requestIssuerDid?: RequestIssuerDid;
  credentialStatusVerifier?: CredentialStatusVerifier;
  statusListStore?: StatusListStore;
  statusListTtlMs?: number;
}

export interface AttributeInput {
  name?: boolean;
  profilePicture?: boolean;
  profileUrl?: boolean;
  socialMedia?: string[] | string | boolean;
  nationality?: string[] | string | boolean;
}

export interface BuildPresentationDefinitionInput {
  id: string;
  name?: string;
  purpose?: string;
  requestType: string;
  targetCredentialType: TargetCredentialTypeValue;
  subject: string;
  policy: PresentationPolicy;
  attributes?: AttributeInput;
  expirationMinimum?: Date | string;
}

export interface BuildPresentationDefinitionFromConfigInput extends Omit<BuildPresentationDefinitionInput, 'policy' | 'attributes' | 'targetCredentialType'> {
  targetCredentialType?: TargetCredentialTypeValue;
}

export interface ValidatePresentationDefinitionOptions {
  mode?: 'strict';
  appConfig?: PresentationAppConfig;
  requestType?: string;
  targetCredentialType?: TargetCredentialTypeValue;
  policy?: PresentationPolicy;
  expectedSubject?: string;
  subject?: string;
  supportedSocialMedia?: string[];
}

export interface PresentationRequestCreateInput {
  requestType: string;
  targetCredentialType: TargetCredentialTypeValue;
  subject: string;
  presentationDefinition: PresentationDefinitionV2;
  pdRequestId: string;
  nonce: string;
  expiresAt: Date | string;
  pdFetchUrl: string;
  submissionUrl: string;
  policy: PresentationPolicy;
}

export interface PresentationRequestCreateFromConfigInput
  extends Omit<PresentationRequestCreateInput, 'presentationDefinition' | 'policy' | 'targetCredentialType'> {
  targetCredentialType?: TargetCredentialTypeValue;
  definition?: {
    id?: string;
    name?: string;
    purpose?: string;
    expirationMinimum?: Date | string;
  };
}

export interface PresentationRequestEnvelope {
  jwtVc: string;
  expiresAt: string;
  pdRequestId: string;
  pdRequestType: string;
  pdHash: string;
  appId: string;
  nonce: string;
}

export interface PresentationRequestCreateFromConfigResult {
  envelope: PresentationRequestEnvelope;
  presentationDefinition: PresentationDefinitionV2;
  verificationContext: {
    policy: PresentationPolicy;
    targetCredentialType: TargetCredentialTypeValue;
  };
}

export interface PresentationSubmissionEnvelope {
  vpJwt: string;
  presentationSubmission?: Record<string, unknown>;
  pdRequestId: string;
  pdRequestType: string;
  pdHash: string;
  nonce: string;
  appId: string;
}

/** HTTP success returned only after the application persists the verified result. */
export interface PresentationSubmissionSuccessResponse {
  ok: true;
  /** App-owned ID of the persisted verification result. */
  recordId: string;
  /** @deprecated Will be removed in a future release. Use HTTP 200/201 and ok instead. */
  status?: 'verified';
}

/** HTTP 4xx/5xx response. message must be safe to display to the user. */
export interface PresentationSubmissionErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
  };
}

export type PresentationSubmissionResponse =
  | PresentationSubmissionSuccessResponse
  | PresentationSubmissionErrorResponse;

export interface ExpectedPresentationRequestState {
  pdRequestId: string;
  pdRequestType: string;
  pdHash: string;
  nonce: string;
  appId: string;
  subject: string;
  submissionUrl: string;
  targetCredentialType: TargetCredentialTypeValue;
}

export interface VerifySubmissionInput {
  submission: PresentationSubmissionEnvelope;
  expected: ExpectedPresentationRequestState;
  storedPresentationDefinition: PresentationDefinitionV2;
  policy: PresentationPolicy;
  credentialStatusPolicy?: VerifyCredentialInput['credentialStatusPolicy'];
}

export interface VerifiedPresentation extends VerifiedCredential {
  /** Opaque VP holder identifier; may be a DID. */
  holderId: string;
  /** @deprecated Use holderId. Retained throughout SDK 1.x; removed in 2.0. */
  holderDid: string;
  /** DID used to sign the presentation. */
  walletDid: string;
  vpDigest: string;
}
