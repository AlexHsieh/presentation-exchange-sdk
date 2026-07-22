import { VerifiableCredential, type PresentationDefinitionV2 } from '@web5/credentials';
import { DidJwk } from '@web5/dids';
import { PresentationDefinitionBuilder } from './builder.js';
import { PolicyTier, RequestVcType, TargetCredentialType } from './constants.js';
import {
  assertAllowedUrlHost,
  assertAppActive,
  assertPresentationRequestMode,
  assertRequestIssuerTrusted,
  assertTargetCredentialTypeAllowed,
  configuredPolicyForTarget,
  getRequestCredentialType,
  validatePresentationAppConfig,
} from './config.js';
import { computePresentationDefinitionHash, encodePresentationDefinition } from './canonicalization.js';
import { buildPresentationDefinition, validatePresentationDefinition } from './definition.js';
import { PresentationSdkError, sdkError } from './errors.js';
import { assertFutureWithin, PRESENTATION_REQUEST_MAX_EXPIRES_IN_MS } from './expiration.js';
import { normalizeSubmissionEnvelope, verifyAndNormalizeSubmission, verifyCredentialJwt } from './exchange.js';
import { StatusListClient } from './status-list.js';
import type {
  AttributeInput,
  BuildPresentationDefinitionInput,
  BuildPresentationDefinitionFromConfigInput,
  PresentationPolicy,
  PresentationDefinitionRegistryField,
  PresentationRequestCreateFromConfigInput,
  PresentationRequestCreateFromConfigResult,
  PresentationRequestCreateInput,
  PresentationRequestEnvelope,
  RequestCredentialTypeConfig,
  PresentationServiceOptions,
  StatusListCacheEntry,
  StatusListReference,
  CredentialValidityResult,
  VerifiedCredential,
  VerifiedPresentation,
  VerifyCredentialInput,
  VerifySubmissionInput,
} from './types.js';

export class PresentationService {
  private readonly statusListClient?: StatusListClient;
  private readonly requestCredentialTypes: Map<string, { entry: RequestCredentialTypeConfig; scopeTitle: string }>;

  constructor(private readonly options: PresentationServiceOptions) {
    validatePresentationAppConfig(options.appConfig);
    this.requestCredentialTypes = new Map(
      options.appConfig.scopes.flatMap((scope) =>
        scope.requestCredentialTypes.map((entry) => [entry.type, { entry, scopeTitle: scope.title }] as const),
      ),
    );
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
    return [...this.requestCredentialTypes.keys()];
  }

  assertRequestCredentialType(type: string): void {
    getRequestCredentialType(this.options.appConfig, type);
  }

  presentationDefinition(): PresentationDefinitionBuilder {
    return new PresentationDefinitionBuilder();
  }

  buildPresentationDefinition(input: BuildPresentationDefinitionInput): PresentationDefinitionV2 {
    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    assertPresentationRequestMode(this.options.appConfig, input.requestType, 'developerDefined');
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
    const targetCredentialType = input.targetCredentialType ?? this.targetCredentialTypeFromConfig(input.requestType);
    assertPresentationRequestMode(this.options.appConfig, input.requestType, 'configDriven');
    if ('attributes' in input) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'attributes must be configured in app config for this helper', {
        requestType: input.requestType,
        targetCredentialType,
      });
    }
    const { policy, attributes } = this.policyFromConfig(input.requestType, targetCredentialType);
    const definition = buildPresentationDefinition({
      ...input,
      targetCredentialType,
      policy,
      attributes,
    });
    return validatePresentationDefinition(definition, {
      mode: 'strict',
      appConfig: this.options.appConfig,
      requestType: input.requestType,
      targetCredentialType,
      expectedSubject: input.subject,
      policy,
    });
  }

  async createRequest(input: PresentationRequestCreateInput): Promise<PresentationRequestEnvelope> {
    assertAppActive(this.options.appConfig);
    if (!this.options.requestIssuerDid) {
      throw sdkError('REQUEST_ISSUER_NOT_TRUSTED', 'requestIssuerDid is required to create request VCs');
    }

    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    assertPresentationRequestMode(this.options.appConfig, input.requestType, 'developerDefined');
    assertAllowedUrlHost(input.pdFetchUrl, this.options.appConfig.allowedPdFetchDomain, 'PD_FETCH_DOMAIN_NOT_ALLOWED');
    assertAllowedUrlHost(input.submissionUrl, this.options.appConfig.allowedVcSubmissionDomain, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');
    validatePresentationDefinition(input.presentationDefinition, {
      mode: 'strict',
      appConfig: this.options.appConfig,
      requestType: input.requestType,
      targetCredentialType: input.targetCredentialType,
      expectedSubject: input.subject,
      policy: input.policy,
    });

    return this.signRequest(input);
  }

  async createRequestFromConfig(input: PresentationRequestCreateFromConfigInput): Promise<PresentationRequestCreateFromConfigResult> {
    const targetCredentialType = input.targetCredentialType ?? this.targetCredentialTypeFromConfig(input.requestType);
    assertPresentationRequestMode(this.options.appConfig, input.requestType, 'configDriven');
    const { policy } = this.policyFromConfig(input.requestType, targetCredentialType);
    const configuredRequestType = this.requestCredentialTypeFromConfig(input.requestType);
    const presentationDefinitionRegistryFields: PresentationDefinitionRegistryField[] = [];
    if (input.definition?.name === undefined) presentationDefinitionRegistryFields.push('name');
    if (input.definition?.purpose === undefined) presentationDefinitionRegistryFields.push('purpose');
    const presentationDefinition = this.buildPresentationDefinitionFromConfig({
      id: input.definition?.id ?? input.pdRequestId,
      name: input.definition?.name ?? configuredRequestType.scopeTitle,
      purpose: input.definition?.purpose ?? configuredRequestType.entry.description,
      requestType: input.requestType,
      targetCredentialType,
      subject: input.subject,
      expirationMinimum: input.definition?.expirationMinimum,
    });
    const envelope = await this.createConfigDrivenRequest({
      ...input,
      targetCredentialType,
      presentationDefinition,
      policy,
      presentationDefinitionRegistryFields,
    });

    return {
      envelope,
      presentationDefinition,
      verificationContext: { policy, targetCredentialType },
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
    assertAllowedUrlHost(input.expected.submissionUrl, this.options.appConfig.allowedVcSubmissionDomain, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');

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

  /**
   * Classifies a stored credential without using exceptions for expected validity outcomes.
   * Use verifyCredential() when an invalid credential should reject the current operation.
   */
  async checkCredentialValidity(input: VerifyCredentialInput): Promise<CredentialValidityResult> {
    assertAppActive(this.options.appConfig);
    const checkedAt = new Date().toISOString();

    // Parse separately so callers can distinguish an unreadable JWT from one whose proof is invalid.
    let parsedCredential: VerifiableCredential;
    try {
      parsedCredential = VerifiableCredential.parseJwt({ vcJwt: input.credentialJwt });
    } catch (error) {
      return invalid('malformed', checkedAt, error);
    }

    const issuanceDate = parsedCredential.vcDataModel.issuanceDate;
    const expirationDate = parsedCredential.vcDataModel.expirationDate;
    const issuanceMs = issuanceDate ? Date.parse(String(issuanceDate)) : Number.NaN;
    const expirationMs = expirationDate ? Date.parse(String(expirationDate)) : Number.NaN;
    if (!issuanceDate || !expirationDate || Number.isNaN(issuanceMs) || Number.isNaN(expirationMs)) {
      return { status: 'invalid', reason: 'dates_invalid', checkedAt };
    }
    if (issuanceMs > Date.now()) return { status: 'invalid', reason: 'not_yet_valid', checkedAt, details: { issuanceDate } };
    if (expirationMs <= Date.now()) return { status: 'invalid', reason: 'expired', checkedAt, details: { expirationDate } };

    try {
      await VerifiableCredential.verify({ vcJwt: input.credentialJwt });
    } catch (error) {
      return invalid('signature_invalid', checkedAt, error);
    }

    try {
      const credential = await this.verifyCredential(input);
      return { status: 'valid', credential, checkedAt };
    } catch (error) {
      if (!(error instanceof PresentationSdkError)) {
        return { status: 'indeterminate', reason: 'status_check_failed', checkedAt, retryable: true, details: { cause: messageFrom(error) } };
      }
      return validityResultFromSdkError(error, checkedAt);
    }
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

  private targetCredentialTypeFromConfig(requestType: string): BuildPresentationDefinitionInput['targetCredentialType'] {
    const { entry } = this.requestCredentialTypeFromConfig(requestType);
    if (entry.targetCredentialType.includes(TargetCredentialType.Human)) {
      return TargetCredentialType.Human;
    }
    return entry.targetCredentialType[0];
  }

  private policyFromConfig(
    requestType: string,
    targetCredentialType: BuildPresentationDefinitionInput['targetCredentialType'],
  ): { policy: PresentationPolicy; attributes: AttributeInput } {
    assertTargetCredentialTypeAllowed(this.options.appConfig, requestType, targetCredentialType);
    const { entry } = this.requestCredentialTypeFromConfig(requestType);
    return configuredPolicyForTarget(entry, targetCredentialType);
  }

  private async createConfigDrivenRequest(
    input: PresentationRequestCreateInput & {
      presentationDefinitionRegistryFields: PresentationDefinitionRegistryField[];
    },
  ): Promise<PresentationRequestEnvelope> {
    assertAppActive(this.options.appConfig);
    if (!this.options.requestIssuerDid) {
      throw sdkError('REQUEST_ISSUER_NOT_TRUSTED', 'requestIssuerDid is required to create request VCs');
    }
    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    assertPresentationRequestMode(this.options.appConfig, input.requestType, 'configDriven');
    assertAllowedUrlHost(input.pdFetchUrl, this.options.appConfig.allowedPdFetchDomain, 'PD_FETCH_DOMAIN_NOT_ALLOWED');
    assertAllowedUrlHost(input.submissionUrl, this.options.appConfig.allowedVcSubmissionDomain, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');
    validatePresentationDefinition(input.presentationDefinition, {
      mode: 'strict', appConfig: this.options.appConfig, requestType: input.requestType,
      targetCredentialType: input.targetCredentialType, expectedSubject: input.subject, policy: input.policy,
    });
    return this.signRequest(input, input.presentationDefinitionRegistryFields);
  }

  private async signRequest(
    input: PresentationRequestCreateInput,
    presentationDefinitionRegistryFields?: PresentationDefinitionRegistryField[],
  ): Promise<PresentationRequestEnvelope> {
    const encodedDefinition = encodePresentationDefinition(input.presentationDefinition);
    const pdHash = computePresentationDefinitionHash(input.presentationDefinition);
    const expiresAt = assertFutureWithin(input.expiresAt, {
      field: 'expiresAt', maxMs: PRESENTATION_REQUEST_MAX_EXPIRES_IN_MS, code: 'PRESENTATION_REQUEST_EXPIRED',
    }).toISOString();
    const bearerDid = await DidJwk.import({ portableDid: this.options.requestIssuerDid as never });
    const vc = await VerifiableCredential.create({
      type: [RequestVcType.PresentationDefinitionTargetRequest, input.requestType], issuer: bearerDid.uri, subject: input.subject,
      data: { presentationDefinition: encodedDefinition, pdHash, pdRequestId: input.pdRequestId, pdRequestType: input.requestType,
        pdFetchUrl: input.pdFetchUrl, submissionUrl: input.submissionUrl, nonce: input.nonce,
        ...(presentationDefinitionRegistryFields === undefined ? {} : { presentationDefinitionRegistryFields }) },
      issuanceDate: new Date().toISOString(), expirationDate: expiresAt,
    });
    const jwtVc = await vc.sign({ did: bearerDid });
    return { jwtVc, expiresAt, pdRequestId: input.pdRequestId, pdRequestType: input.requestType, pdHash,
      appId: this.options.appConfig.appId, nonce: input.nonce };
  }

  private requestCredentialTypeFromConfig(requestType: string): { entry: RequestCredentialTypeConfig; scopeTitle: string } {
    const configured = this.requestCredentialTypes.get(requestType);
    if (configured) return configured;
    getRequestCredentialType(this.options.appConfig, requestType);
    throw new Error('Unreachable request credential type lookup');
  }
}

function invalid(reason: Extract<CredentialValidityResult, { status: 'invalid' }>['reason'], checkedAt: string, error: unknown): CredentialValidityResult {
  return { status: 'invalid', reason, checkedAt, details: { cause: messageFrom(error) } };
}

function validityResultFromSdkError(error: PresentationSdkError, checkedAt: string): CredentialValidityResult {
  const details = Object.keys(error.details).length > 0 ? error.details : undefined;
  switch (error.code) {
    case 'PRESENTATION_REQUEST_EXPIRED':
      return { status: 'invalid', reason: 'expired', checkedAt, details };
    case 'CREDENTIAL_PROVIDER_INVALID':
      return { status: 'invalid', reason: 'issuer_not_allowed', checkedAt, details };
    case 'TARGET_VC_TYPE_NOT_ALLOWED':
      return { status: 'invalid', reason: 'type_not_allowed', checkedAt, details };
    case 'CREDENTIAL_REVOKED':
      return { status: 'invalid', reason: 'revoked', checkedAt, details };
    case 'CREDENTIAL_STATUS_INVALID':
      if (error.details.reason === 'status_required') {
        return { status: 'invalid', reason: 'status_required', checkedAt, details };
      }
      return { status: 'invalid', reason: 'status_rejected', checkedAt, details };
    case 'STATUS_LIST_URL_NOT_ALLOWED':
      return { status: 'invalid', reason: 'status_reference_not_allowed', checkedAt, details };
    case 'STATUS_LIST_FETCH_FAILED':
      return { status: 'indeterminate', reason: 'status_list_unavailable', checkedAt, retryable: true, details };
    case 'STATUS_LIST_INVALID':
      return { status: 'indeterminate', reason: 'status_list_invalid', checkedAt, retryable: true, details };
    case 'PRESENTATION_SUBMISSION_INVALID':
      if (error.message.includes('future')) return { status: 'invalid', reason: 'not_yet_valid', checkedAt, details };
      if (error.message.includes('issuanceDate') || error.message.includes('expirationDate')) {
        return { status: 'invalid', reason: 'dates_invalid', checkedAt, details };
      }
      if (error.message.includes('supported target type')) {
        return { status: 'invalid', reason: 'unsupported_type', checkedAt, details };
      }
      return { status: 'invalid', reason: 'malformed', checkedAt, details };
    default:
      return { status: 'indeterminate', reason: 'status_check_failed', checkedAt, retryable: true, details: { code: error.code, ...error.details } };
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
