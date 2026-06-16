import { VerifiableCredential, type PresentationDefinitionV2 } from '@web5/credentials';
import { DidJwk } from '@web5/dids';
import { PresentationDefinitionBuilder } from './builder.js';
import { RequestVcType } from './constants.js';
import {
  assertAllowedUrlHost,
  assertAppActive,
  assertRequestIssuerTrusted,
  assertTargetCredentialTypeAllowed,
  getRequestCredentialType,
  providerDidsForEnvironment,
  validatePresentationAppConfig,
} from './config.js';
import { computePresentationDefinitionHash, encodePresentationDefinition } from './canonicalization.js';
import { buildPresentationDefinition, validatePresentationDefinition } from './definition.js';
import { sdkError } from './errors.js';
import { normalizeSubmissionEnvelope, verifyAndNormalizeSubmission } from './exchange.js';
import type {
  BuildPresentationDefinitionInput,
  PresentationRequestCreateInput,
  PresentationRequestEnvelope,
  PresentationServiceOptions,
  VerifiedPresentation,
  VerifySubmissionInput,
} from './types.js';

const reservedRequestSubjectFields = new Set([
  'tier',
  'presentationDefinition',
  'pdHash',
  'pdRequestId',
  'pdRequestType',
  'pdParams',
  'pdFetchUrl',
  'submissionUrl',
  'nonce',
]);

export class PresentationService {
  constructor(private readonly options: PresentationServiceOptions) {
    validatePresentationAppConfig(options.appConfig);
    assertRequestIssuerTrusted(options.appConfig, options.requestIssuerDid);
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

  async createRequest(input: PresentationRequestCreateInput): Promise<PresentationRequestEnvelope> {
    assertAppActive(this.options.appConfig);
    if (!this.options.requestIssuerDid) {
      throw sdkError('REQUEST_ISSUER_NOT_TRUSTED', 'requestIssuerDid is required to create request VCs');
    }

    assertTargetCredentialTypeAllowed(this.options.appConfig, input.requestType, input.targetCredentialType);
    assertAllowedUrlHost(input.pdFetchUrl, this.options.appConfig.allowedPdFetchDomains, 'PD_FETCH_DOMAIN_NOT_ALLOWED');
    assertAllowedUrlHost(input.submissionUrl, this.options.appConfig.allowedVcSubmissionDomains, 'VC_SUBMISSION_DOMAIN_NOT_ALLOWED');
    assertAdditionalSubjectData(input.additionalCredentialSubjectData);

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
    const expiresAt = toIsoString(input.expiresAt, 'expiresAt');
    const bearerDid = await DidJwk.import({ portableDid: this.options.requestIssuerDid as never });

    const vc = await VerifiableCredential.create({
      type: [RequestVcType.PresentationDefinitionTargetRequest, input.requestType],
      issuer: bearerDid.uri,
      subject: input.subject,
      data: {
        tier: input.policy.tier,
        presentationDefinition: encodedDefinition,
        pdHash,
        pdRequestId: input.pdRequestId,
        pdRequestType: input.requestType,
        pdParams: input.pdParams ?? {
          tier: input.policy.tier,
          personalDataSource: input.policy.personalDataSource,
        },
        pdFetchUrl: input.pdFetchUrl,
        submissionUrl: input.submissionUrl,
        nonce: input.nonce,
        ...(input.additionalCredentialSubjectData ?? {}),
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

    const acceptedProviderDids = providerDidsForEnvironment(
      this.options.deploymentEnvironment,
      this.options.acceptedCredentialProviders,
    );
    const verified = await verifyAndNormalizeSubmission({
      input: { ...input, submission },
      acceptedProviderDids,
      credentialStatusVerifier: this.options.credentialStatusVerifier,
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
}

function assertAdditionalSubjectData(value?: Record<string, unknown>): void {
  if (!value) return;
  const reserved = Object.keys(value).filter((key) => reservedRequestSubjectFields.has(key));
  if (reserved.length > 0) {
    throw sdkError('PRESENTATION_REQUEST_CONFLICT', 'additionalCredentialSubjectData overwrites reserved request fields', {
      reserved,
    });
  }
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

function toIsoString(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', `${field} must be a valid date-time`, { value });
  }
  return date.toISOString();
}
