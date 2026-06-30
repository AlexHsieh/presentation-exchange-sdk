import { PresentationPath, TargetCredentialType } from './constants.js';
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

const requiredPathsByTarget: Record<TargetCredentialTypeValue, string[]> = {
  [TargetCredentialType.Human]: [
    PresentationPath.Type,
    PresentationPath.ExpirationDate,
    PresentationPath.IssuanceDate,
    PresentationPath.SubjectId,
    PresentationPath.PdRequestType,
  ],
  [TargetCredentialType.Uniqueness]: [
    PresentationPath.Type,
    PresentationPath.ExpirationDate,
    PresentationPath.IssuanceDate,
    PresentationPath.SubjectId,
    PresentationPath.PdRequestType,
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
