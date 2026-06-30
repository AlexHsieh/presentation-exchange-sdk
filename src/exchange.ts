import { createHash } from 'node:crypto';
import { Jwt, PresentationExchange, VerifiableCredential, VerifiablePresentation, type PresentationDefinitionV2 } from '@web5/credentials';
import { PresentationPath } from './constants.js';
import { sdkError } from './errors.js';
import { extractRequiredPaths, validateWithPresentationExchange } from './definition.js';
import { normalizePresentationPath, tierFromCredentialTypes } from './policy.js';
import type {
  CredentialStatusVerifier,
  PresentationSubmissionEnvelope,
  TargetCredentialTypeValue,
  VerifiedCredential,
  VerifiedPresentation,
  VerifyCredentialInput,
  VerifySubmissionInput,
} from './types.js';

type SubmissionEvaluationPayload = {
  presentation?: Record<string, unknown>;
  presentation_submission?: Record<string, unknown>;
  [key: string]: unknown;
};

export async function evaluateSubmission(
  definition: PresentationDefinitionV2,
  submission: SubmissionEvaluationPayload,
): Promise<{ valid: boolean; reason?: string }> {
  let reason: string | undefined;
  const expirationMinimum = extractExpirationMinimum(definition);
  const sanitizedDefinition = stripFormatMinimum(definition);

  try {
    validateWithPresentationExchange(definition);
  } catch (error) {
    return { valid: false, reason: `Invalid presentation definition: ${messageFrom(error)}` };
  }

  if (submission.presentation_submission) {
    try {
      PresentationExchange.validateSubmission({
        presentationSubmission: submission.presentation_submission as never,
      });
    } catch (error) {
      reason = `Presentation submission invalid: ${messageFrom(error)}`;
    }
  }

  if (!reason) {
    try {
      const presentation = (submission.presentation ?? submission) as Record<string, unknown>;
      PresentationExchange.evaluatePresentation({
        presentationDefinition: sanitizedDefinition as never,
        presentation: presentation as never,
      });
    } catch (error) {
      reason = `Presentation evaluation failed: ${messageFrom(error)}`;
    }
  }

  if (!reason && expirationMinimum) {
    reason = checkExpirationMinimum(expirationMinimum, submission);
  }

  return { valid: !reason, reason };
}

export async function verifyAndNormalizeSubmission(params: {
  input: VerifySubmissionInput;
  acceptedProviderDids: string[];
  credentialStatusVerifier?: CredentialStatusVerifier;
  expectedTargetCredentialType?: TargetCredentialTypeValue;
}): Promise<VerifiedPresentation> {
  const { input, acceptedProviderDids, credentialStatusVerifier, expectedTargetCredentialType } = params;
  const submission = normalizeSubmissionEnvelope(input.submission);
  let parsedVp: VerifiablePresentation;
  let walletDid: string;

  try {
    const verifiedVp = await VerifiablePresentation.verify({ vpJwt: submission.vpJwt });
    walletDid = String(verifiedVp.issuer ?? '');
    if (!walletDid) {
      walletDid = String(Jwt.parse({ jwt: submission.vpJwt }).decoded.payload.iss ?? '');
    }
    if (!walletDid) {
      throw new Error('VP issuer is missing');
    }
    parsedVp = VerifiablePresentation.parseJwt({ vpJwt: submission.vpJwt });
  } catch (error) {
    throw sdkError('VP_VERIFY_FAILED', messageFrom(error), { cause: messageFrom(error) });
  }

  const submissionPayload: SubmissionEvaluationPayload = { presentation: parsedVp.vpDataModel as unknown as Record<string, unknown> };
  if (submission.presentationSubmission) submissionPayload.presentation_submission = submission.presentationSubmission;

  const evaluation = await evaluateSubmission(input.storedPresentationDefinition, submissionPayload);
  if (!evaluation.valid) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', evaluation.reason ?? 'Submission did not satisfy presentation definition', {
      reason: evaluation.reason,
    });
  }

  const credentialJwt = extractPrimaryCredentialJwt(parsedVp);
  const verifiedCredential = await verifyCredentialJwt(
    {
      credentialJwt,
      acceptedProviderDids,
      expectedTargetCredentialType,
    },
    credentialStatusVerifier,
    input,
  );

  return {
    holderDid: String(parsedVp.holder ?? ''),
    walletDid,
    ...verifiedCredential,
    vpDigest: createHash('sha256').update(submission.vpJwt).digest('hex'),
  };
}

export async function verifyCredentialJwt(
  input: VerifyCredentialInput,
  credentialStatusVerifier?: CredentialStatusVerifier,
  submissionInput?: VerifySubmissionInput,
): Promise<VerifiedCredential> {
  const { credentialJwt, acceptedProviderDids = [], expectedTargetCredentialType } = input;
  let credential: VerifiableCredential;
  try {
    credential = VerifiableCredential.parseJwt({ vcJwt: credentialJwt });
    await VerifiableCredential.verify({ vcJwt: credentialJwt });
  } catch (error) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Unable to parse or verify primary credential', {
      cause: messageFrom(error),
    });
  }

  const issuerDid = issuerFromCredential(credential);
  if (acceptedProviderDids.length > 0 && !acceptedProviderDids.includes(issuerDid)) {
    throw sdkError('CREDENTIAL_PROVIDER_INVALID', 'Credential issuer is not an accepted provider', {
      issuerDid,
      acceptedProviderDids,
    });
  }

  const credentialTypes = credentialTypesFrom(credential);
  if (expectedTargetCredentialType && !credentialTypes.includes(expectedTargetCredentialType)) {
    throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Credential type does not match expected target credential type', {
      credentialTypes,
      targetCredentialType: expectedTargetCredentialType,
    });
  }
  const credentialTier = tierFromCredentialTypes(credentialTypes);
  if (!credentialTier) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential does not contain a supported target type', {
      credentialTypes,
    });
  }

  const issuanceDate = credential.vcDataModel.issuanceDate;
  const expirationDate = credential.vcDataModel.expirationDate;
  if (!issuanceDate || !expirationDate || Number.isNaN(Date.parse(String(expirationDate)))) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential issuanceDate and expirationDate are required');
  }
  if (Date.parse(String(expirationDate)) <= Date.now()) {
    throw sdkError('PRESENTATION_REQUEST_EXPIRED', 'Credential is expired', { expirationDate });
  }

  const credentialSubject = subjectFromCredential(credential);
  if (submissionInput) {
    validatePolicyAttributes(submissionInput, credentialSubject, credentialTypes);
  }
  const statusList = statusListFromCredential(credential);
  if (credentialStatusVerifier) {
    const ok = await credentialStatusVerifier({ statusList, credentialJwt, credentialSubject });
    if (!ok) {
      throw sdkError('CREDENTIAL_STATUS_INVALID', 'Credential status verification failed', { statusList });
    }
  }

  return {
    issuerDid,
    credentialJwt,
    credentialTypes,
    credentialTier,
    credentialSubject,
    issuanceDate: String(issuanceDate),
    expirationDate: String(expirationDate),
    ...(statusList ? { statusList } : {}),
    normalized: normalizedSubject(credentialSubject),
  };
}

export function normalizeSubmissionEnvelope(submission: PresentationSubmissionEnvelope): PresentationSubmissionEnvelope {
  return {
    ...submission,
    presentationSubmission: submission.presentationSubmission ?? submission.presentation_submission,
  };
}

export function stripFormatMinimum(definition: PresentationDefinitionV2): PresentationDefinitionV2 {
  const cloned = JSON.parse(JSON.stringify(definition)) as PresentationDefinitionV2;
  for (const descriptor of cloned.input_descriptors ?? []) {
    for (const field of descriptor.constraints?.fields ?? []) {
      const filter = field.filter as Record<string, unknown> | undefined;
      if (filter && 'formatMinimum' in filter) delete filter.formatMinimum;
    }
  }
  return cloned;
}

function extractPrimaryCredentialJwt(parsedVp: VerifiablePresentation): string {
  const raw = (parsedVp as unknown as { verifiableCredential?: unknown }).verifiableCredential;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const credentialJwt = items.find((item): item is string => typeof item === 'string');
  if (!credentialJwt) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'No verifiable credential provided');
  }
  return credentialJwt;
}

function extractExpirationMinimum(definition: PresentationDefinitionV2): Date | null {
  let latest: Date | null = null;
  for (const descriptor of definition.input_descriptors ?? []) {
    for (const field of descriptor.constraints?.fields ?? []) {
      const paths = (Array.isArray(field.path) ? field.path : [field.path]).map((path) =>
        typeof path === 'string' ? normalizePresentationPath(path) : '',
      );
      if (!paths.includes(PresentationPath.ExpirationDate)) continue;
      const filter = field.filter as Record<string, unknown> | undefined;
      if (typeof filter?.formatMinimum !== 'string') continue;
      const parsed = new Date(filter.formatMinimum);
      if (!Number.isNaN(parsed.getTime()) && (!latest || parsed.getTime() > latest.getTime())) latest = parsed;
    }
  }
  return latest;
}

function checkExpirationMinimum(minimum: Date, submission: SubmissionEvaluationPayload): string | undefined {
  const presentation = (submission.presentation ?? submission) as Record<string, unknown>;
  const credentials = extractCredentials(presentation);
  if (credentials.length === 0) return 'Credential expirationDate is missing or invalid.';

  for (const credential of credentials) {
    const expirationDate = credential.expirationDate;
    if (typeof expirationDate !== 'string') return 'Credential expirationDate is missing or invalid.';
    const parsed = new Date(expirationDate);
    if (Number.isNaN(parsed.getTime())) return 'Credential expirationDate is missing or invalid.';
    if (parsed.getTime() < minimum.getTime()) {
      return `Credential expirationDate ${expirationDate} is before required minimum ${minimum.toISOString()}.`;
    }
  }
  return undefined;
}

function extractCredentials(presentation: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = presentation.verifiableCredential;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items
    .map((item) => (typeof item === 'string' ? tryParseCredentialJwt(item) : item))
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function tryParseCredentialJwt(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return (payload.vc as Record<string, unknown> | undefined) ?? payload;
  } catch {
    return null;
  }
}

function subjectFromCredential(credential: VerifiableCredential): Record<string, unknown> {
  const subject = credential.vcDataModel.credentialSubject;
  if (Array.isArray(subject)) return (subject[0] ?? {}) as Record<string, unknown>;
  return (subject ?? {}) as Record<string, unknown>;
}

function issuerFromCredential(credential: VerifiableCredential): string {
  const issuer = credential.vcDataModel.issuer;
  if (typeof issuer === 'string') return issuer;
  return String((issuer as { id?: string } | undefined)?.id ?? issuer ?? '');
}

function credentialTypesFrom(credential: VerifiableCredential): string[] {
  const raw = credential.vcDataModel.type;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => String(item)).filter(Boolean);
}

function statusListFromCredential(credential: VerifiableCredential): VerifiedPresentation['statusList'] | undefined {
  const raw = credential.vcDataModel.credentialStatus as unknown as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const url = String(raw.statusListCredential ?? '');
  if (!url) return undefined;
  return {
    index: Number(raw.statusListIndex ?? 0),
    url,
    ...(raw.id ? { credentialId: String(raw.id) } : {}),
  };
}

function validatePolicyAttributes(
  input: VerifySubmissionInput,
  credentialSubject: Record<string, unknown>,
  credentialTypes: string[],
): void {
  const paths = extractRequiredPaths(input.storedPresentationDefinition);
  if (paths.includes(PresentationPath.Name) && typeof credentialSubject.name !== 'string') {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential is missing requested name');
  }
  if (paths.includes(PresentationPath.ProfilePicture) && typeof credentialSubject.profilePicture !== 'string') {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential is missing requested profilePicture');
  }
  if (paths.includes(PresentationPath.ProfileUrl) && typeof credentialSubject.profileUrl !== 'string') {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential is missing requested profileUrl');
  }
  if (paths.includes(PresentationPath.SocialMedia) && !credentialSubject.socialMedia) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential is missing requested socialMedia');
  }
  if (paths.includes(PresentationPath.Nationality) && !credentialSubject.nationality) {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential is missing requested nationality');
  }
  const tier = tierFromCredentialTypes(credentialTypes);
  if (input.policy.tier === 'uniqueness' && tier !== 'uniqueness') {
    throw sdkError('PRESENTATION_SUBMISSION_INVALID', 'Credential does not satisfy uniqueness policy');
  }
}

function normalizedSubject(credentialSubject: Record<string, unknown>): VerifiedPresentation['normalized'] {
  return {
    ...(typeof credentialSubject.name === 'string' ? { name: credentialSubject.name } : {}),
    ...(typeof credentialSubject.profilePicture === 'string' ? { profilePicture: credentialSubject.profilePicture } : {}),
    ...(typeof credentialSubject.profileUrl === 'string' ? { profileUrl: credentialSubject.profileUrl } : {}),
    ...normalizeArrayField('socialMedia', credentialSubject.socialMedia, (item) => item.toLowerCase()),
    ...normalizeArrayField('nationality', credentialSubject.nationality, (item) => item.toUpperCase()),
  };
}

function normalizeArrayField(
  key: 'socialMedia' | 'nationality',
  value: unknown,
  mapper: (value: string) => string,
): Partial<VerifiedPresentation['normalized']> {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const normalized = Array.from(new Set(list.map((item) => mapper(String(item).trim())).filter(Boolean)));
  return normalized.length > 0 ? { [key]: normalized } : {};
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
