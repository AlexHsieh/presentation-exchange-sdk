import type { PresentationDefinitionV2 } from '@web5/credentials';
import type { PersonalDataSource, PolicyTier, TargetCredentialType } from './constants.js';

export type PolicyTierValue = (typeof PolicyTier)[keyof typeof PolicyTier];
export type PersonalDataSourceValue = (typeof PersonalDataSource)[keyof typeof PersonalDataSource];
export type TargetCredentialTypeValue = (typeof TargetCredentialType)[keyof typeof TargetCredentialType];
export type AppStatus = 'draft' | 'testing' | 'active' | 'suspended' | 'revoked';

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

export interface RequestCredentialTypeConfig {
  type: string;
  description?: string;
  targetCredentialType: TargetCredentialTypeValue[];
  targetCredentialPolicies?: Partial<Record<TargetCredentialTypeValue, TargetCredentialPolicyConfig>>;
}

export interface PresentationAppConfig {
  appId: string;
  tenantId: string;
  appDid: string;
  requestCredentialTypes: RequestCredentialTypeConfig[];
  allowedOrigins: string[];
  allowedPdFetchDomains: string[];
  allowedVcSubmissionDomains: string[];
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

export type StatusListResponseBody = {
  statusListJwt: string;
  updatedAt?: string;
  nextCheckAt?: string;
};

export type StatusListCacheEntry = {
  statusListUrl: string;
  statusListJwt: string;
  statusListCredential: Record<string, unknown>;
  fetchedAt: Date;
  updatedAt?: string;
  nextCheckAt?: string;
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
}

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

export interface PresentationRequestEnvelope {
  jwtVc: string;
  expiresAt: string;
  pdRequestId: string;
  pdRequestType: string;
  pdHash: string;
  appId: string;
  nonce: string;
}

export interface PresentationSubmissionEnvelope {
  vpJwt: string;
  presentationSubmission?: Record<string, unknown>;
  presentation_submission?: Record<string, unknown>;
  pdRequestId: string;
  pdRequestType: string;
  pdHash: string;
  nonce: string;
  appId: string;
}

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
}

export interface VerifiedPresentation extends VerifiedCredential {
  holderDid: string;
  walletDid: string;
  vpDigest: string;
}
