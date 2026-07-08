import { PersonalDataSource, PresentationPath, TargetCredentialType } from './constants.js';
import { sdkError, type PresentationSdkErrorCode } from './errors.js';
import { normalizePresentationPath } from './policy.js';
import type {
  PresentationAppConfig,
  RequestCredentialTypeConfig,
  RequestIssuerDid,
  TargetCredentialTypeValue,
} from './types.js';

const appStatuses = new Set(['draft', 'testing', 'active', 'suspended', 'revoked']);
const targetCredentialTypes = new Set<string>(Object.values(TargetCredentialType));
const personalDataSourceValues = new Set<string>(Object.values(PersonalDataSource));
const supportedNationalityValues = new Set(['TWN', 'USA']);
const supportedSocialMediaValues = new Set(['facebook', 'linemessage']);

const requiredPathsByTarget: Record<TargetCredentialTypeValue, string[]> = {
  [TargetCredentialType.Human]: [
    PresentationPath.Type,
    PresentationPath.ExpirationDate,
    PresentationPath.IssuanceDate,
    PresentationPath.SubjectId,
    PresentationPath.PdRequestType,
    PresentationPath.PersonalDataSource,
  ],
  [TargetCredentialType.Uniqueness]: [
    PresentationPath.Type,
    PresentationPath.ExpirationDate,
    PresentationPath.IssuanceDate,
    PresentationPath.SubjectId,
    PresentationPath.PdRequestType,
    PresentationPath.PersonalDataSource,
  ],
};

export function validatePresentationAppConfig(appConfig: PresentationAppConfig): PresentationAppConfig {
  if (!appConfig || typeof appConfig !== 'object') {
    throw sdkError('APP_NOT_REGISTERED', 'App config is required');
  }
  if (!isNonEmptyString(appConfig.appId)) {
    throw sdkError('APP_NOT_REGISTERED', 'App config is missing appId');
  }
  for (const field of ['tenantId', 'appDid', 'version'] as const) {
    if (!isNonEmptyString(appConfig[field])) {
      throw sdkError('APP_NOT_REGISTERED', `App config is missing ${field}`, { field });
    }
  }
  if (!appStatuses.has(appConfig.status)) {
    throw sdkError('APP_NOT_REGISTERED', 'App config status is invalid', { status: appConfig.status });
  }
  if (!Array.isArray(appConfig.requestCredentialTypes) || appConfig.requestCredentialTypes.length === 0) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'At least one request credential type is required');
  }

  for (const entry of appConfig.requestCredentialTypes) {
    validateRequestCredentialTypeEntry(entry);
    for (const target of entry.targetCredentialType) {
      if (!appConfig.allowedTargetCredentialTypes.includes(target)) {
        throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Request type target is not included in allowedTargetCredentialTypes', {
          requestType: entry.type,
          targetCredentialType: target,
        });
      }
      assertRequiredPathsPresent(appConfig, target);
    }
  }

  for (const field of [
    'allowedOrigins',
    'allowedPdFetchDomains',
    'allowedVcSubmissionDomains',
    'allowedTargetCredentialTypes',
    'allowedPresentationPaths',
    'acceptedCredentialProviders',
  ] as const) {
    if (!Array.isArray(appConfig[field])) {
      throw sdkError('APP_NOT_REGISTERED', `App config ${field} must be an array`, { field });
    }
  }
  if (appConfig.acceptedCredentialProviders.length === 0 || !appConfig.acceptedCredentialProviders.every(isNonEmptyString)) {
    throw sdkError('APP_NOT_REGISTERED', 'App config acceptedCredentialProviders must include at least one DID', {
      field: 'acceptedCredentialProviders',
    });
  }
  if (appConfig.statusListUrl !== undefined) {
    assertValidStatusListBaseUrl(appConfig.statusListUrl);
  }

  return appConfig;
}

export function assertRequestIssuerTrusted(appConfig: PresentationAppConfig, requestIssuerDid?: RequestIssuerDid): void {
  if (!requestIssuerDid) return;
  if (requestIssuerDid.uri !== appConfig.appDid) {
    throw sdkError('REQUEST_ISSUER_NOT_TRUSTED', 'Request issuer DID does not match app config', {
      expected: appConfig.appDid,
      actual: requestIssuerDid.uri,
    });
  }
}

export function assertAppActive(appConfig: PresentationAppConfig): void {
  validatePresentationAppConfig(appConfig);
  if (appConfig.status !== 'active' && appConfig.status !== 'testing') {
    throw sdkError('APP_NOT_ACTIVE', 'Presentation app is not active', {
      appId: appConfig.appId,
      status: appConfig.status,
    });
  }
}

export function getRequestCredentialType(appConfig: PresentationAppConfig, requestType: string): RequestCredentialTypeConfig {
  const entry = appConfig.requestCredentialTypes.find((item) => item.type === requestType);
  if (!entry) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', `Request credential type is not registered: ${requestType}`, {
      requestType,
      allowed: appConfig.requestCredentialTypes.map((item) => item.type),
    });
  }
  return entry;
}

export function assertTargetCredentialTypeAllowed(
  appConfig: PresentationAppConfig,
  requestType: string,
  targetCredentialType: TargetCredentialTypeValue,
): void {
  const entry = getRequestCredentialType(appConfig, requestType);
  if (!entry.targetCredentialType.includes(targetCredentialType)) {
    throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential type is not allowed for request type', {
      requestType,
      targetCredentialType,
      allowed: entry.targetCredentialType,
    });
  }
  if (!appConfig.allowedTargetCredentialTypes.includes(targetCredentialType)) {
    throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential type is not globally allowed for app', {
      targetCredentialType,
      allowed: appConfig.allowedTargetCredentialTypes,
    });
  }
}

export function assertAllowedUrlHost(url: string, allowedHosts: string[], errorCode: PresentationSdkErrorCode): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw sdkError(errorCode, 'URL is invalid', { url });
  }

  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.map((item) => item.toLowerCase());
  if (!allowed.includes(host) && !allowed.includes(hostname)) {
    throw sdkError(errorCode, 'URL host is not allowlisted', { url, host, allowedHosts });
  }
}

function validateRequestCredentialTypeEntry(entry: RequestCredentialTypeConfig): void {
  if (!entry || typeof entry !== 'object' || !isNonEmptyString(entry.type)) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'Request credential type entry is invalid', { entry });
  }
  if (!Array.isArray(entry.targetCredentialType) || entry.targetCredentialType.length === 0) {
    throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Request credential type must include at least one target credential type', {
      requestType: entry.type,
    });
  }
  for (const target of entry.targetCredentialType) {
    if (!targetCredentialTypes.has(target)) {
      throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential type is unsupported', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
  }
  validateTargetCredentialPolicies(entry);
}

function validateTargetCredentialPolicies(entry: RequestCredentialTypeConfig): void {
  const policies = entry.targetCredentialPolicies;
  if (policies === undefined) return;
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'targetCredentialPolicies must be an object', {
      requestType: entry.type,
    });
  }

  for (const [target, policy] of Object.entries(policies)) {
    if (!targetCredentialTypes.has(target)) {
      throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential policy target is unsupported', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    if (!entry.targetCredentialType.includes(target as TargetCredentialTypeValue)) {
      throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential policy target is not selected for request type', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential policy is invalid', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    if (!personalDataSourceValues.has(policy.personalDataSource)) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential policy personalDataSource is unsupported', {
        requestType: entry.type,
        targetCredentialType: target,
        personalDataSource: policy.personalDataSource,
      });
    }
    if (target === TargetCredentialType.Human && policy.personalDataSource === PersonalDataSource.OfficialDocument) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Human target credential policy cannot use officialDocument', {
        requestType: entry.type,
        targetCredentialType: target,
        personalDataSource: policy.personalDataSource,
      });
    }
    validateConfiguredAttributes(entry.type, target as TargetCredentialTypeValue, policy);
  }
}

function validateConfiguredAttributes(
  requestType: string,
  target: TargetCredentialTypeValue,
  policy: NonNullable<RequestCredentialTypeConfig['targetCredentialPolicies']>[TargetCredentialTypeValue],
): void {
  const attributes = policy?.attributes;
  if (attributes === undefined) return;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'Target credential policy attributes must be an object', {
      requestType,
      targetCredentialType: target,
    });
  }

  if (attributes.name && policy.personalDataSource === PersonalDataSource.NotProvided) {
    throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', 'notProvided cannot request name', {
      requestType,
      targetCredentialType: target,
      attribute: 'name',
      source: policy.personalDataSource,
    });
  }

  for (const attribute of ['profilePicture', 'profileUrl', 'socialMedia'] as const) {
    if (attributes[attribute] && policy.personalDataSource !== PersonalDataSource.PlatformUserData) {
      throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', `${attribute} requires platformUserData`, {
        requestType,
        targetCredentialType: target,
        attribute,
        source: policy.personalDataSource,
      });
    }
  }

  if (attributes.socialMedia !== undefined) {
    const values = normalizeStringList(attributes.socialMedia, (item) => item.toLowerCase());
    if (values.some((value) => !supportedSocialMediaValues.has(value))) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'socialMedia policy value is unsupported', {
        requestType,
        targetCredentialType: target,
        socialMedia: attributes.socialMedia,
      });
    }
  }

  if (attributes.nationality !== undefined) {
    if (target !== TargetCredentialType.Uniqueness) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality policy requires UniquenessVerifiableCredential', {
        requestType,
        targetCredentialType: target,
      });
    }
    const values = normalizeStringList(attributes.nationality, (item) => item.toUpperCase());
    if (values.some((value) => !supportedNationalityValues.has(value))) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality policy value is unsupported', {
        requestType,
        targetCredentialType: target,
        nationality: attributes.nationality,
      });
    }
  }
}

function assertRequiredPathsPresent(appConfig: PresentationAppConfig, target: TargetCredentialTypeValue): void {
  const allowedPaths = new Set(appConfig.allowedPresentationPaths.map(normalizePresentationPath));
  for (const path of requiredPathsByTarget[target]) {
    if (!allowedPaths.has(normalizePresentationPath(path))) {
      throw sdkError('PD_PATH_NOT_ALLOWED', 'App config is missing a required Presentation Definition path', {
        targetCredentialType: target,
        path,
      });
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStringList(value: unknown, mapper: (item: string) => string): string[] {
  if (value === undefined || value === false || value === null || value === true) return [];
  const raw = Array.isArray(value) ? value : [value];
  return Array.from(new Set(raw.map((item) => mapper(String(item).trim())).filter((item) => item.length > 0)));
}

function assertValidStatusListBaseUrl(value: unknown): void {
  if (!isNonEmptyString(value)) {
    throw sdkError('APP_NOT_REGISTERED', 'App config statusListUrl must be a non-empty URL', {
      field: 'statusListUrl',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw sdkError('APP_NOT_REGISTERED', 'App config statusListUrl must be a valid URL', {
      field: 'statusListUrl',
      statusListUrl: value,
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw sdkError('APP_NOT_REGISTERED', 'App config statusListUrl must use http or https', {
      field: 'statusListUrl',
      statusListUrl: value,
    });
  }
}
