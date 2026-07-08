import { VerifiableCredential, type PresentationDefinitionV2 } from '@web5/credentials';
import { DidJwk } from '@web5/dids';
import { PresentationDefinitionBuilder } from './builder.js';
import { PolicyTier, RequestVcType, TargetCredentialType } from './constants.js';
import {
  assertAllowedUrlHost,
  assertAppActive,
  assertRequestIssuerTrusted,
  assertTargetCredentialTypeAllowed,
  getRequestCredentialType,
  validatePresentationAppConfig,
} from './config.js';
import { computePresentationDefinitionHash, encodePresentationDefinition } from './canonicalization.js';
import { buildPresentationDefinition, validatePresentationDefinition } from './definition.js';
import { sdkError } from './errors.js';
import { assertFutureWithin, PRESENTATION_REQUEST_MAX_EXPIRES_IN_MS } from './expiration.js';
import { normalizeSubmissionEnvelope, verifyAndNormalizeSubmission, verifyCredentialJwt } from './exchange.js';
import { StatusListClient } from './status-list.js';
import type {
  AttributeInput,
  BuildPresentationDefinitionInput,
  BuildPresentationDefinitionFromConfigInput,
  PresentationPolicy,
  PresentationRequestCreateInput,
  PresentationRequestEnvelope,
  PresentationServiceOptions,
  StatusListCacheEntry,
  StatusListReference,
  VerifiedCredential,
  VerifiedPresentation,
  VerifyCredentialInput,
  VerifySubmissionInput,
} from './types.js';

export class PresentationService {
  private readonly statusListClient?: StatusListClient;

  constructor(private readonly options: PresentationServiceOptions) {
    validatePresentationAppConfig(options.appConfig);
    assertRequestIssuerTrusted(options.appConfig, options.requestIssuerDid);
    if (options.appConfig.statusListUrl) {
      this.statusListClient = new StatusListClient({
        statusListUrl: options.appConfig.statusListUrl,
        ttlMs: options.statusListTtlMs,
        store: options.statusListStore,
      });
    }
  }

  get appConfig() {
    return this.options.appConfig;
  }

  getRequestCredentialTypes(): string[] {
    return this.options.appConfig.requestCredentialTypes.map((entry) => entry.type);
  }

  assertRequestCredentialType(type: string): void {
    getRequestCredentialType(this.options.appConfig, type);
  }

  presentationDefinition(): PresentationDefinitionBuilder {
    return new PresentationDefinitionBuilder();
  }

  buildPresentationDefinition(input: BuildPresentationDefinitionInput): PresentationDefinitionV2 {
    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    const definition = buildPresentationDefinition(input);
    return validatePresentationDefinition(definition, {
      mode: 'strict',
      appConfig: this.options.appConfig,
      requestType: input.requestType,
      targetCredentialType: input.targetCredentialType,
      expectedSubject: input.subject,
      policy: input.policy,
    });
  }

  buildPresentationDefinitionFromConfig(input: BuildPresentationDefinitionFromConfigInput): PresentationDefinitionV2 {
    if ('attributes' in input) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'attributes must be configured in app config for this helper', {
        requestType: input.requestType,
        targetCredentialType: input.targetCredentialType,
      });
    }
    const { policy, attributes } = this.policyFromConfig(input.requestType, input.targetCredentialType);
    return this.buildPresentationDefinition({
      ...input,
      policy,
      attributes,
    });
  }

  async createRequest(input: PresentationRequestCreateInput): Promise<PresentationRequestEnvelope> {
    assertAppActive(this.options.appConfig);
    if (!this.options.requestIssuerDid) {
      throw sdkError('REQUEST_ISSUER_NOT_TRUSTED', 'requestIssuerDid is required to create request VCs');
    }

    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    assertAllowedUrlHost(input.pdFetchUrl, this.options.appConfig.allowedPdFetchDomains, 'PD_FETCH_DOMAIN_NOT_ALLOWED');
    assertAllowedUrlHost(input.submissionUrl, this.options.appConfig.allowedVcSubmissionDomains, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');
    validatePresentationDefinition(input.presentationDefinition, {
      mode: 'strict',
      appConfig: this.options.appConfig,
      requestType: input.requestType,
      targetCredentialType: input.targetCredentialType,
      expectedSubject: input.subject,
      policy: input.policy,
    });

    const encodedDefinition = encodePresentationDefinition(input.presentationDefinition);
    const pdHash = computePresentationDefinitionHash(input.presentationDefinition);
    const expiresAt = assertFutureWithin(input.expiresAt, {
      field: 'expiresAt',
      maxMs: PRESENTATION_REQUEST_MAX_EXPIRES_IN_MS,
      code: 'PRESENTATION_REQUEST_EXPIRED',
    }).toISOString();
    const bearerDid = await DidJwk.import({ portableDid: this.options.requestIssuerDid as never });

    const vc = await VerifiableCredential.create({
      type: [RequestVcType.PresentationDefinitionTargetRequest, input.requestType],
      issuer: bearerDid.uri,
      subject: input.subject,
      data: {
        presentationDefinition: encodedDefinition,
        pdHash,
        pdRequestId: input.pdRequestId,
        pdRequestType: input.requestType,
        pdFetchUrl: input.pdFetchUrl,
        submissionUrl: input.submissionUrl,
        nonce: input.nonce,
      },
      issuanceDate: new Date().toISOString(),
      expirationDate: expiresAt,
    });
    const jwtVc = await vc.sign({ did: bearerDid });

    return {
      jwtVc,
      expiresAt,
      pdRequestId: input.pdRequestId,
      pdRequestType: input.requestType,
      pdHash,
      appId: this.options.appConfig.appId,
      nonce: input.nonce,
    };
  }

  async verifySubmission(input: VerifySubmissionInput): Promise<VerifiedPresentation> {
    assertAppActive(this.options.appConfig);
    const submission = normalizeSubmissionEnvelope(input.submission);

    assertBinding('pdRequestId', submission.pdRequestId, input.expected.pdRequestId);
    assertBinding('pdRequestType', submission.pdRequestType, input.expected.pdRequestType);
    assertHashBinding(submission.pdHash, input.expected.pdHash);
    assertNonceBinding(submission.nonce, input.expected.nonce);
    assertBinding('appId', submission.appId, input.expected.appId);
    assertBinding('appId', input.expected.appId, this.options.appConfig.appId);

    assertTargetCredentialTypeAllowed(
      this.options.appConfig,
      input.expected.pdRequestType,
      input.expected.targetCredentialType,
    );
    assertAllowedUrlHost(input.expected.submissionUrl, this.options.appConfig.allowedVcSubmissionDomains, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');

    const computedHash = computePresentationDefinitionHash(input.storedPresentationDefinition);
    if (computedHash !== input.expected.pdHash) {
      throw sdkError('PD_HASH_MISMATCH', 'Stored Presentation Definition hash does not match expected hash', {
        expected: computedHash,
        actual: input.expected.pdHash,
      });
    }

    validatePresentationDefinition(input.storedPresentationDefinition, {
      mode: 'strict',
      appConfig: this.options.appConfig,
      requestType: input.expected.pdRequestType,
      targetCredentialType: input.expected.targetCredentialType,
      expectedSubject: input.expected.subject,
      policy: input.policy,
    });

    const verified = await verifyAndNormalizeSubmission({
      input: { ...input, submission },
      acceptedProviderDids: this.options.appConfig.acceptedCredentialProviders,
      credentialStatusVerifier: this.options.credentialStatusVerifier ?? this.defaultCredentialStatusVerifier(),
      expectedTargetCredentialType: input.expected.targetCredentialType,
    });

    if (!verified.credentialTypes.includes(input.expected.targetCredentialType)) {
      throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Credential type does not match expected target credential type', {
        credentialTypes: verified.credentialTypes,
        targetCredentialType: input.expected.targetCredentialType,
      });
    }

    return verified;
  }

  async verifyCredential(input: VerifyCredentialInput): Promise<VerifiedCredential> {
    assertAppActive(this.options.appConfig);
    return verifyCredentialJwt(
      {
        ...input,
        acceptedProviderDids: input.acceptedProviderDids ?? this.options.appConfig.acceptedCredentialProviders,
      },
      this.options.credentialStatusVerifier ?? this.defaultCredentialStatusVerifier(),
    );
  }

  async getStatusList(input: string | StatusListReference): Promise<StatusListCacheEntry> {
    return this.requireStatusListClient().getStatusList(input);
  }

  buildStatusListUrl(statusId: string): string {
    return this.requireStatusListClient().buildStatusListUrl(statusId);
  }

  async verifyCredentialStatus(input: { credentialJwt: string; statusList?: StatusListReference }): Promise<boolean> {
    if (this.options.credentialStatusVerifier) {
      return this.options.credentialStatusVerifier({
        ...input,
        credentialSubject: {},
      });
    }
    return this.requireStatusListClient().verifyCredentialStatus(input);
  }

  private defaultCredentialStatusVerifier() {
    if (!this.statusListClient) {
      return undefined;
    }
    return async ({ credentialJwt, statusList }: { credentialJwt: string; statusList?: StatusListReference }) => {
      const ok = await this.statusListClient!.verifyCredentialStatus({ credentialJwt, statusList });
      if (!ok) {
        throw sdkError('CREDENTIAL_REVOKED', 'Credential is revoked', { statusList });
      }
      return true;
    };
  }

  private requireStatusListClient(): StatusListClient {
    if (!this.statusListClient) {
      throw sdkError('STATUS_LIST_URL_NOT_ALLOWED', 'statusListUrl is required for status-list operations');
    }
    return this.statusListClient;
  }

  private policyFromConfig(
    requestType: string,
    targetCredentialType: BuildPresentationDefinitionInput['targetCredentialType'],
  ): { policy: PresentationPolicy; attributes: AttributeInput } {
    assertTargetCredentialTypeAllowed(this.options.appConfig, requestType, targetCredentialType);
    const entry = getRequestCredentialType(this.options.appConfig, requestType);
    const configured = entry.targetCredentialPolicies?.[targetCredentialType];
    if (!configured) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential policy is not configured for request type', {
        requestType,
        targetCredentialType,
      });
    }
    const policy = {
      tier: targetCredentialType === TargetCredentialType.Uniqueness ? PolicyTier.Uniqueness : PolicyTier.Human,
      personalDataSource: configured.personalDataSource,
    };
    const attributes = {
      ...(configured.personalDataSource === 'platformUserData' ? platformUserDataDefaultAttributes : {}),
      ...(configured.attributes ?? {}),
    };
    return {
      policy,
      attributes,
    };
  }
}

const platformUserDataDefaultAttributes: AttributeInput = {
  name: true,
  profilePicture: true,
  socialMedia: ['facebook', 'linemessage'],
};

function assertBinding(field: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw sdkError('PRESENTATION_REQUEST_CONFLICT', `${field} does not match expected request state`, {
      field,
      expected,
      actual,
    });
  }
}

function assertHashBinding(actual: string, expected: string): void {
  if (actual !== expected) {
    throw sdkError('PD_HASH_MISMATCH', 'pdHash does not match expected request state', { expected, actual });
  }
}

function assertNonceBinding(actual: string, expected: string): void {
  if (actual !== expected) {
    throw sdkError('PD_NONCE_MISMATCH', 'nonce does not match expected request state', { expected, actual });
  }
}
