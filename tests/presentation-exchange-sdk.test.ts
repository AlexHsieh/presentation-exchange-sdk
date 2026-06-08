import { describe, expect, it } from 'vitest';
import { DidJwk } from '@web5/dids';
import { VerifiableCredential, VerifiablePresentation, type PresentationDefinitionV2 } from '@web5/credentials';
import {
  PersonalDataSource,
  PolicyTier,
  PresentationPath,
  PresentationSdkError,
  PresentationService,
  TargetCredentialType,
  buildPresentationDefinitionTemplate,
  computePresentationDefinitionHash,
  encodePresentationDefinition,
  isPersonalDataSourceValue,
  PERSONAL_DATA_SOURCE_VALUES,
  validatePresentationAppConfig,
  validatePresentationDefinition,
} from '../src/index.js';
import type { PresentationAppConfig, PresentationPolicy, RequestIssuerDid, VerifySubmissionInput } from '../src/index.js';

const requestType = 'VoterRequestVerifiableCredential';
const subject = 'urn:uuid:vote-1';
const allowedPaths = [
  PresentationPath.Type,
  PresentationPath.ExpirationDate,
  PresentationPath.IssuanceDate,
  PresentationPath.SubjectId,
  PresentationPath.PdRequestType,
  PresentationPath.Name,
  PresentationPath.ProfilePicture,
  PresentationPath.ProfileUrl,
  PresentationPath.SocialMedia,
  PresentationPath.Nationality,
];

function appConfig(overrides: Partial<PresentationAppConfig> = {}): PresentationAppConfig {
  return {
    appId: 'vote-app',
    tenantId: 'tenant-test',
    environment: 'test',
    trustedRequestIssuerDid: 'did:jwk:test-request-issuer',
    requestCredentialTypes: [
      {
        type: requestType,
        description: 'Voter request',
        targetCredentialType: [TargetCredentialType.Human, TargetCredentialType.Uniqueness],
      },
    ],
    allowedOrigins: ['https://vote.example'],
    allowedPdFetchDomains: ['vote.example'],
    allowedVcSubmissionDomains: ['vote.example'],
    allowedTargetCredentialTypes: [TargetCredentialType.Human, TargetCredentialType.Uniqueness],
    allowedPresentationPaths: allowedPaths,
    status: 'active',
    version: '2026-06-03.1',
    ...overrides,
  };
}

function service(config: PresentationAppConfig = appConfig()): PresentationService {
  return new PresentationService({ appConfig: config });
}

function policy(
  tier: PresentationPolicy['tier'] = PolicyTier.Human,
  personalDataSource: PresentationPolicy['personalDataSource'] = PersonalDataSource.PlatformUserData,
): PresentationPolicy {
  return { tier, personalDataSource };
}

function filterFor(definition: PresentationDefinitionV2, path: string): Record<string, unknown> | undefined {
  const field = definition.input_descriptors[0].constraints.fields?.find((item) => item.path.includes(path));
  return field?.filter as Record<string, unknown> | undefined;
}

async function generatedRequestIssuerDid(): Promise<RequestIssuerDid> {
  const did = await DidJwk.create();
  return (await did.export()) as unknown as RequestIssuerDid;
}

async function signedVpFor(params: {
  issuerDid: Awaited<ReturnType<typeof DidJwk.create>>;
  holderDid: Awaited<ReturnType<typeof DidJwk.create>>;
  credentialSubject?: Record<string, unknown>;
  credentialType?: string;
  expirationDate?: string;
}) {
  const credentialSubject = {
    id: subject,
    pdRequestType: requestType,
    name: 'Ada',
    profilePicture: 'https://vote.example/ada.png',
    profileUrl: 'https://vote.example/ada',
    socialMedia: 'facebook',
    ...params.credentialSubject,
  };
  const credential = await VerifiableCredential.create({
    type: params.credentialType ?? TargetCredentialType.Human,
    issuer: params.issuerDid.uri,
    subject,
    data: credentialSubject,
    issuanceDate: new Date(Date.now() - 60_000).toISOString(),
    expirationDate: params.expirationDate ?? new Date(Date.now() + 86_400_000).toISOString(),
  });
  const credentialJwt = await credential.sign({ did: params.issuerDid });
  const presentation = await VerifiablePresentation.create({
    holder: params.holderDid.uri,
    vcJwts: [credentialJwt],
  });
  const vpJwt = await presentation.sign({ did: params.holderDid });
  return { vpJwt, credentialJwt, credentialSubject };
}

describe('Presentation Exchange SDK config and policy', () => {
  it('exports personal data source values and predicate', () => {
    expect(PERSONAL_DATA_SOURCE_VALUES).toEqual(['platformUserData', 'officialDocument', 'notProvided']);
    expect(isPersonalDataSourceValue(PersonalDataSource.PlatformUserData)).toBe(true);
    expect(isPersonalDataSourceValue('other')).toBe(false);
  });

  it('validates app config and rejects untrusted request issuer DID', async () => {
    expect(() => validatePresentationAppConfig(appConfig())).not.toThrow();

    const requestIssuerDid = await generatedRequestIssuerDid();
    expectSdkCode(
      () =>
        new PresentationService({
          appConfig: appConfig({ trustedRequestIssuerDid: `${requestIssuerDid.uri}:other` }),
          requestIssuerDid,
        }),
      'REQUEST_ISSUER_NOT_TRUSTED',
    );
  });

  it('rejects target credential types not allowed by the selected request type', () => {
    const sdk = service(
      appConfig({
        requestCredentialTypes: [
          {
            type: requestType,
            targetCredentialType: [TargetCredentialType.Human],
          },
        ],
        allowedTargetCredentialTypes: [TargetCredentialType.Human],
      }),
    );

    expectSdkCode(() =>
      sdk.buildPresentationDefinition({
        id: 'pd-1',
        requestType,
        targetCredentialType: TargetCredentialType.Uniqueness,
        subject,
        policy: policy(PolicyTier.Uniqueness),
        attributes: { nationality: ['TWN'] },
      }),
    'TARGET_VC_TYPE_NOT_ALLOWED');
  });

  it('enforces personal data source and tier capability rules', () => {
    const sdk = service();

    expectSdkCode(() =>
      sdk.buildPresentationDefinition({
        id: 'pd-official-picture',
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        subject,
        policy: policy(PolicyTier.Human, PersonalDataSource.OfficialDocument),
        attributes: { profilePicture: true },
      }),
    'ATTRIBUTE_SOURCE_NOT_ALLOWED');

    expectSdkCode(() =>
      sdk.buildPresentationDefinition({
        id: 'pd-not-provided-name',
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        subject,
        policy: policy(PolicyTier.Human, PersonalDataSource.NotProvided),
        attributes: { name: true },
      }),
    'ATTRIBUTE_SOURCE_NOT_ALLOWED');

    expectSdkCode(() =>
      sdk.buildPresentationDefinition({
        id: 'pd-human-nationality',
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        subject,
        policy: policy(PolicyTier.Uniqueness),
        attributes: { nationality: ['TWN'] },
      }),
    'ATTRIBUTE_NOT_ALLOWED');
  });
});

describe('Presentation Definition builder and canonicalization', () => {
  it('builds valid generic Presentation Definition templates without app-bound fields', () => {
    const definition = buildPresentationDefinitionTemplate({
      id: 'pd-template-uniqueness',
      name: 'Uniqueness Credential',
      purpose: 'Requires a uniqueness credential.',
      targetCredentialType: TargetCredentialType.Uniqueness,
      policy: policy(PolicyTier.Uniqueness),
      attributes: {
        name: true,
        profilePicture: true,
        socialMedia: true,
      },
    });

    const paths = definition.input_descriptors[0].constraints.fields?.flatMap((field) => field.path) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining([
        PresentationPath.Type,
        PresentationPath.ExpirationDate,
        PresentationPath.IssuanceDate,
        PresentationPath.Name,
        PresentationPath.ProfilePicture,
        PresentationPath.SocialMedia,
      ]),
    );
    expect(paths).not.toContain(PresentationPath.SubjectId);
    expect(paths).not.toContain(PresentationPath.PdRequestType);
    expect(() =>
      validatePresentationDefinition(definition, {
        mode: 'strict',
        appConfig: appConfig(),
        targetCredentialType: TargetCredentialType.Uniqueness,
        policy: policy(PolicyTier.Uniqueness),
        supportedSocialMedia: ['facebook', 'linemessage'],
      }),
    ).not.toThrow();
  });

  it('builds a valid normalized Presentation Definition with automatic required fields', () => {
    const sdk = service();
    const definition = sdk
      .presentationDefinition()
      .id('pd-vote-1')
      .name('Vote title: Test')
      .purpose('Prove you are a real human to vote.')
      .requestType(requestType)
      .targetCredentialType(TargetCredentialType.Human)
      .subject(subject)
      .policy(policy())
      .require('name')
      .require('profilePicture')
      .require('profileUrl')
      .require('socialMedia', { oneOf: ['facebook', 'linemessage'] })
      .expiresAfter('2026-07-01T00:00:00Z')
      .build();

    const paths = definition.input_descriptors[0].constraints.fields?.flatMap((field) => field.path) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining([
        PresentationPath.Type,
        PresentationPath.ExpirationDate,
        PresentationPath.IssuanceDate,
        PresentationPath.SubjectId,
        PresentationPath.PdRequestType,
        PresentationPath.Name,
        PresentationPath.ProfilePicture,
        PresentationPath.ProfileUrl,
        PresentationPath.SocialMedia,
      ]),
    );
    expect(() =>
      validatePresentationDefinition(definition, {
        mode: 'strict',
        appConfig: appConfig(),
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        expectedSubject: subject,
        policy: policy(),
        supportedSocialMedia: ['facebook', 'linemessage'],
      }),
    ).not.toThrow();
  });

  it('defaults empty socialMedia and nationality attributes to supported enum filters', () => {
    const socialDefinition = service()
      .presentationDefinition()
      .id('pd-default-social')
      .requestType(requestType)
      .targetCredentialType(TargetCredentialType.Human)
      .subject(subject)
      .policy(policy())
      .require('socialMedia')
      .build();
    const socialFilter = filterFor(socialDefinition, PresentationPath.SocialMedia);

    expect(socialFilter).toEqual({ type: 'string', enum: ['facebook', 'linemessage'] });
    expect(() =>
      validatePresentationDefinition(socialDefinition, {
        mode: 'strict',
        appConfig: appConfig(),
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        expectedSubject: subject,
        policy: policy(),
        supportedSocialMedia: ['facebook', 'linemessage'],
      }),
    ).not.toThrow();

    const nationalityDefinition = service().buildPresentationDefinition({
      id: 'pd-default-nationality',
      requestType,
      targetCredentialType: TargetCredentialType.Uniqueness,
      subject,
      policy: policy(PolicyTier.Uniqueness),
      attributes: { nationality: true },
    });
    const nationalityFilter = filterFor(nationalityDefinition, PresentationPath.Nationality);

    expect(nationalityFilter).toEqual({ type: 'string', enum: ['TWN', 'USA'] });
    expect(() =>
      validatePresentationDefinition(nationalityDefinition, {
        mode: 'strict',
        appConfig: appConfig(),
        requestType,
        targetCredentialType: TargetCredentialType.Uniqueness,
        expectedSubject: subject,
        policy: policy(PolicyTier.Uniqueness),
      }),
    ).not.toThrow();
  });

  it('treats empty arrays as supported defaults for socialMedia and nationality', () => {
    const definition = service().buildPresentationDefinition({
      id: 'pd-empty-array-defaults',
      requestType,
      targetCredentialType: TargetCredentialType.Uniqueness,
      subject,
      policy: policy(PolicyTier.Uniqueness),
      attributes: { socialMedia: [], nationality: [] },
    });

    expect(filterFor(definition, PresentationPath.SocialMedia)).toEqual({ type: 'string', enum: ['facebook', 'linemessage'] });
    expect(filterFor(definition, PresentationPath.Nationality)).toEqual({ type: 'string', enum: ['TWN', 'USA'] });
  });

  it('builds explicit subset enum filters for socialMedia and nationality', () => {
    const socialDefinition = service().buildPresentationDefinition({
      id: 'pd-social-subset',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
      attributes: { socialMedia: ['facebook'] },
    });

    expect(filterFor(socialDefinition, PresentationPath.SocialMedia)).toEqual({ type: 'string', enum: ['facebook'] });

    const nationalityDefinition = service().buildPresentationDefinition({
      id: 'pd-nationality-subset',
      requestType,
      targetCredentialType: TargetCredentialType.Uniqueness,
      subject,
      policy: policy(PolicyTier.Uniqueness),
      attributes: { nationality: ['TWN'] },
    });

    expect(filterFor(nationalityDefinition, PresentationPath.Nationality)).toEqual({ type: 'string', enum: ['TWN'] });
  });

  it('rejects unsupported socialMedia and nationality values during build', () => {
    expectSdkCode(
      () =>
        service().buildPresentationDefinition({
          id: 'pd-unsupported-social',
          requestType,
          targetCredentialType: TargetCredentialType.Human,
          subject,
          policy: policy(),
          attributes: { socialMedia: ['twitter'] },
        }),
      'ATTRIBUTE_NOT_ALLOWED',
    );

    expectSdkCode(
      () =>
        service().buildPresentationDefinition({
          id: 'pd-unsupported-nationality',
          requestType,
          targetCredentialType: TargetCredentialType.Uniqueness,
          subject,
          policy: policy(PolicyTier.Uniqueness),
          attributes: { nationality: ['JPN'] },
        }),
      'ATTRIBUTE_NOT_ALLOWED',
    );
  });

  it('computes deterministic hashes for equivalent object key orderings', () => {
    const definition = service().buildPresentationDefinition({
      id: 'pd-hash',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
      attributes: { name: true },
    });
    const equivalent = {
      input_descriptors: definition.input_descriptors,
      id: definition.id,
    } as PresentationDefinitionV2;

    expect(encodePresentationDefinition(definition)).toBe(encodePresentationDefinition(equivalent));
    expect(computePresentationDefinitionHash(definition)).toBe(computePresentationDefinitionHash(equivalent));
  });

  it('rejects registry-disallowed paths and invalid nationality filters', () => {
    const definition = service().buildPresentationDefinition({
      id: 'pd-nationality',
      requestType,
      targetCredentialType: TargetCredentialType.Uniqueness,
      subject,
      policy: policy(PolicyTier.Uniqueness),
      attributes: { nationality: ['TWN'] },
    });

    expectSdkCode(() =>
      validatePresentationDefinition(definition, {
        mode: 'strict',
        appConfig: appConfig({ allowedPresentationPaths: allowedPaths.filter((path) => path !== PresentationPath.Nationality) }),
        requestType,
        targetCredentialType: TargetCredentialType.Uniqueness,
        expectedSubject: subject,
        policy: policy(PolicyTier.Uniqueness),
      }),
    'PD_PATH_NOT_ALLOWED');

    const invalidDefinition = JSON.parse(JSON.stringify(definition)) as PresentationDefinitionV2;
    const nationalityField = invalidDefinition.input_descriptors[0].constraints.fields?.find((field) =>
      field.path.includes(PresentationPath.Nationality),
    );
    if (nationalityField) {
      nationalityField.filter = { type: 'string', enum: ['tw'] };
    }

    expectSdkCode(() =>
      validatePresentationDefinition(invalidDefinition, {
        mode: 'strict',
        appConfig: appConfig(),
        requestType,
        targetCredentialType: TargetCredentialType.Uniqueness,
        expectedSubject: subject,
        policy: policy(PolicyTier.Uniqueness),
      }),
    'ATTRIBUTE_NOT_ALLOWED');
  });
});

describe('Presentation request creation', () => {
  it('signs wallet-compatible request envelopes and rejects reserved subject overwrites', async () => {
    const requestIssuerDid = await generatedRequestIssuerDid();
    const sdk = new PresentationService({
      appConfig: appConfig({ trustedRequestIssuerDid: requestIssuerDid.uri }),
      requestIssuerDid,
    });
    const definition = sdk.buildPresentationDefinition({
      id: 'pd-request',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
      attributes: { name: true },
    });

    await expectRejectsSdkCode(
      sdk.createRequest({
        requestType,
        targetCredentialType: TargetCredentialType.Human,
        subject,
        presentationDefinition: definition,
        pdRequestId: 'session-1',
        nonce: 'nonce-1',
        expiresAt: new Date(Date.now() + 60_000),
        pdFetchUrl: 'https://vote.example/pd?sessionId=session-1',
        submissionUrl: 'https://vote.example/submit',
        policy: policy(),
        additionalCredentialSubjectData: { pdHash: 'override' },
      }),
      'PRESENTATION_REQUEST_CONFLICT',
    );

    const envelope = await sdk.createRequest({
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      presentationDefinition: definition,
      pdRequestId: 'session-1',
      nonce: 'nonce-1',
      expiresAt: new Date(Date.now() + 60_000),
      pdFetchUrl: 'https://vote.example/pd?sessionId=session-1',
      submissionUrl: 'https://vote.example/submit',
      policy: policy(),
      additionalCredentialSubjectData: { resourceId: 'vote-1' },
    });

    expect(envelope).toMatchObject({
      pdRequestId: 'session-1',
      pdRequestType: requestType,
      appId: 'vote-app',
      nonce: 'nonce-1',
      pdHash: computePresentationDefinitionHash(definition),
    });
    const parsed = VerifiableCredential.parseJwt({ vcJwt: envelope.jwtVc });
    expect(parsed.vcDataModel.credentialSubject).toMatchObject({
      presentationDefinition: encodePresentationDefinition(definition),
      pdHash: envelope.pdHash,
      pdRequestId: 'session-1',
      pdRequestType: requestType,
      submissionUrl: 'https://vote.example/submit',
      nonce: 'nonce-1',
      resourceId: 'vote-1',
    });
  });

  it('rejects inactive apps and disallowed request URLs', async () => {
    const requestIssuerDid = await generatedRequestIssuerDid();
    const inactive = new PresentationService({
      appConfig: appConfig({ trustedRequestIssuerDid: requestIssuerDid.uri, status: 'draft' }),
      requestIssuerDid,
    });
    const active = new PresentationService({
      appConfig: appConfig({ trustedRequestIssuerDid: requestIssuerDid.uri }),
      requestIssuerDid,
    });
    const definition = active.buildPresentationDefinition({
      id: 'pd-url',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
    });
    const input = {
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      presentationDefinition: definition,
      pdRequestId: 'session-1',
      nonce: 'nonce-1',
      expiresAt: new Date(Date.now() + 60_000),
      pdFetchUrl: 'https://vote.example/pd',
      submissionUrl: 'https://vote.example/submit',
      policy: policy(),
    };

    await expectRejectsSdkCode(inactive.createRequest(input), 'APP_NOT_ACTIVE');
    await expectRejectsSdkCode(
      active.createRequest({ ...input, pdFetchUrl: 'https://evil.example/pd' }),
      'PD_FETCH_DOMAIN_NOT_ALLOWED',
    );
    await expectRejectsSdkCode(
      active.createRequest({ ...input, submissionUrl: 'https://evil.example/submit' }),
      'VC_SUBMISSION_DOMAIN_NOT_ALLOWED',
    );
  });
});

describe('Submission verification', () => {
  it('verifies submissions and returns normalized credential metadata', async () => {
    const issuerDid = await DidJwk.create();
    const holderDid = await DidJwk.create();
    const sdk = new PresentationService({
      appConfig: appConfig(),
      acceptedCredentialProviders: { test: [issuerDid.uri] },
    });
    const storedPresentationDefinition = sdk.buildPresentationDefinition({
      id: 'pd-submit',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
      attributes: {
        name: true,
        profilePicture: true,
        profileUrl: true,
        socialMedia: ['facebook'],
      },
    });
    const pdHash = computePresentationDefinitionHash(storedPresentationDefinition);
    const { vpJwt, credentialJwt } = await signedVpFor({ issuerDid, holderDid });

    const verified = await sdk.verifySubmission(
      verifyInput({
        vpJwt,
        storedPresentationDefinition,
        pdHash,
      }),
    );

    expect(verified).toMatchObject({
      holderDid: holderDid.uri,
      issuerDid: issuerDid.uri,
      credentialJwt,
      credentialTypes: expect.arrayContaining([TargetCredentialType.Human]),
      credentialTier: PolicyTier.Human,
      normalized: {
        name: 'Ada',
        profilePicture: 'https://vote.example/ada.png',
        profileUrl: 'https://vote.example/ada',
        socialMedia: ['facebook'],
      },
    });
    expect(verified.vpDigest).toHaveLength(64);
  });

  it('rejects binding, provider, target type, and status verification failures', async () => {
    const issuerDid = await DidJwk.create();
    const holderDid = await DidJwk.create();
    const sdk = new PresentationService({
      appConfig: appConfig(),
      acceptedCredentialProviders: { test: [issuerDid.uri] },
      credentialStatusVerifier: async () => false,
    });
    const storedPresentationDefinition = service().buildPresentationDefinition({
      id: 'pd-submit-failures',
      requestType,
      targetCredentialType: TargetCredentialType.Human,
      subject,
      policy: policy(),
      attributes: { name: true },
    });
    const pdHash = computePresentationDefinitionHash(storedPresentationDefinition);
    const { vpJwt } = await signedVpFor({
      issuerDid,
      holderDid,
      credentialSubject: {
        credentialStatus: {
          statusListCredential: 'https://vote.example/status/1',
          statusListIndex: '1',
        },
      },
    });

    await expectRejectsSdkCode(
      sdk.verifySubmission(
        verifyInput({
          vpJwt,
          storedPresentationDefinition,
          pdHash,
          nonce: 'wrong',
        }),
      ),
      'PD_NONCE_MISMATCH',
    );

    const untrustedIssuerDid = await DidJwk.create();
    const { vpJwt: untrustedVpJwt } = await signedVpFor({ issuerDid: untrustedIssuerDid, holderDid });
    await expectRejectsSdkCode(
      sdk.verifySubmission(
        verifyInput({
          vpJwt: untrustedVpJwt,
          storedPresentationDefinition,
          pdHash,
        }),
      ),
      'CREDENTIAL_PROVIDER_INVALID',
    );

    const { vpJwt: uniquenessVpJwt } = await signedVpFor({
      issuerDid,
      holderDid,
      credentialType: TargetCredentialType.Uniqueness,
    });
    await expectRejectsSdkCode(
      sdk.verifySubmission(
        verifyInput({
          vpJwt: uniquenessVpJwt,
          storedPresentationDefinition,
          pdHash,
        }),
      ),
      'TARGET_VC_TYPE_NOT_ALLOWED',
    );

    await expectRejectsSdkCode(
      sdk.verifySubmission(
        verifyInput({
          vpJwt,
          storedPresentationDefinition,
          pdHash,
        }),
      ),
      'CREDENTIAL_STATUS_INVALID',
    );
  });
});

function verifyInput(params: {
  vpJwt: string;
  storedPresentationDefinition: PresentationDefinitionV2;
  pdHash: string;
  nonce?: string;
}): VerifySubmissionInput {
  return {
    submission: {
      vpJwt: params.vpJwt,
      presentationSubmission: undefined,
      pdRequestId: 'session-1',
      pdRequestType: requestType,
      pdHash: params.pdHash,
      nonce: params.nonce ?? 'nonce-1',
      appId: 'vote-app',
    },
    expected: {
      pdRequestId: 'session-1',
      pdRequestType: requestType,
      pdHash: params.pdHash,
      nonce: 'nonce-1',
      appId: 'vote-app',
      subject,
      submissionUrl: 'https://vote.example/submit',
      targetCredentialType: TargetCredentialType.Human,
    },
    storedPresentationDefinition: params.storedPresentationDefinition,
    policy: policy(),
  };
}

function expectSdkCode(action: () => unknown, expectedCode: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationSdkError);
    expect((error as PresentationSdkError).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected PresentationSdkError ${expectedCode}`);
}

async function expectRejectsSdkCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationSdkError);
    expect((error as PresentationSdkError).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected PresentationSdkError ${expectedCode}`);
}
