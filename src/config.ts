import { PersonalDataSource, PresentationPath, TargetCredentialType } from './constants.js';
import { sdkError, type PresentationSdkErrorCode } from './errors.js';
import { normalizePresentationPath } from './policy.js';
import type {
  AttributeInput,
  PresentationAppConfig,
  PresentationPolicy,
  PresentationScopeConfig,
  RequestCredentialTypeConfig,
  RequestIssuerDid,
  TargetCredentialCapabilityConfig,
  TargetCredentialPolicyConfig,
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
  if (!Array.isArray(appConfig.scopes) || appConfig.scopes.length === 0) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'At least one presentation scope is required');
  }
  for (const scope of appConfig.scopes) validateScope(scope);

  const requestTypes = scopedRequestCredentialTypes(appConfig);

  const requestTypeNames = new Set<string>();
  for (const { scope, entry } of requestTypes) {
    validateRequestCredentialTypeEntry(entry);
    if (requestTypeNames.has(entry.type)) {
      throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'Request credential type is configured in more than one scope', {
        requestType: entry.type,
      });
    }
    requestTypeNames.add(entry.type);
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

  for (const field of ['allowedTargetCredentialTypes', 'allowedPresentationPaths', 'acceptedCredentialProviders'] as const) {
    if (!Array.isArray(appConfig[field])) {
      throw sdkError('APP_NOT_REGISTERED', `App config ${field} must be an array`, { field });
    }
  }
  for (const field of ['allowedOrigin', 'allowedPdFetchDomain', 'allowedVcSubmissionDomain'] as const) {
    if (!isNonEmptyString(appConfig[field])) {
      throw sdkError('APP_NOT_REGISTERED', `App config ${field} must be a non-empty string`, { field });
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
  const configured = scopedRequestCredentialTypes(appConfig).find(({ entry }) => entry.type === requestType);
  if (!configured) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', `Request credential type is not registered: ${requestType}`, {
      requestType,
      allowed: scopedRequestCredentialTypes(appConfig).map(({ entry }) => entry.type),
    });
  }
  return configured.entry;
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

export function assertPresentationRequestMode(
  appConfig: PresentationAppConfig,
  requestType: string,
  expected: 'configDriven' | 'developerDefined',
): RequestCredentialTypeConfig {
  const entry = getRequestCredentialType(appConfig, requestType);
  if (entry.presentationRequestMode !== expected) {
    throw sdkError('PRESENTATION_REQUEST_MODE_NOT_ALLOWED', `Request type must use ${entry.presentationRequestMode} helpers`, {
      requestType,
      expected: entry.presentationRequestMode,
      actual: expected,
    });
  }
  return entry;
}

export function configuredPolicyForTarget(
  entry: RequestCredentialTypeConfig,
  target: TargetCredentialTypeValue,
): { policy: PresentationPolicy; attributes: AttributeInput } {
  if (entry.presentationRequestMode !== 'configDriven') {
    throw sdkError('PRESENTATION_REQUEST_MODE_NOT_ALLOWED', 'Developer-defined request types do not have a fixed policy', {
      requestType: entry.type,
      targetCredentialType: target,
    });
  }
  const configured = entry.targetCredentialPolicies[target];
  if (!configured) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential policy is not configured for request type', {
      requestType: entry.type,
      targetCredentialType: target,
    });
  }
  return {
    policy: {
      tier: target === TargetCredentialType.Uniqueness ? 'uniqueness' : 'human',
      personalDataSource: configured.personalDataSource,
    },
    attributes: configuredAttributes(configured),
  };
}

export function capabilitiesForTarget(
  entry: RequestCredentialTypeConfig,
  target: TargetCredentialTypeValue,
): TargetCredentialCapabilityConfig {
  if (entry.presentationRequestMode !== 'developerDefined') {
    throw sdkError('PRESENTATION_REQUEST_MODE_NOT_ALLOWED', 'Config-driven request types do not have developer capabilities', {
      requestType: entry.type,
      targetCredentialType: target,
    });
  }
  const capabilities = entry.targetCredentialCapabilities[target];
  if (!capabilities) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential capabilities are not configured for request type', {
      requestType: entry.type,
      targetCredentialType: target,
    });
  }
  return capabilities;
}

export function assertAllowedUrlHost(url: string, allowedHost: string, errorCode: PresentationSdkErrorCode): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw sdkError(errorCode, 'URL is invalid', { url });
  }

  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const allowed = allowedHost.toLowerCase();
  if (allowed !== host && allowed !== hostname) {
    throw sdkError(errorCode, 'URL host is not allowlisted', { url, host, allowedHost });
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
  if (entry.presentationRequestMode === 'configDriven') {
    validateTargetCredentialPolicies(entry);
    return;
  }
  if (entry.presentationRequestMode === 'developerDefined') {
    validateTargetCredentialCapabilities(entry);
    return;
  }
  throw sdkError('PRESENTATION_REQUEST_MODE_NOT_ALLOWED', 'Request credential type presentationRequestMode is required', {
    requestType: 'unknown',
  });
}

function validateScope(scope: PresentationScopeConfig): void {
  if (!scope || typeof scope !== 'object') {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'Presentation scope is invalid', { scope });
  }
  for (const field of ['scopeId', 'title'] as const) {
    if (!isNonEmptyString(scope[field])) {
      throw sdkError('REQUEST_TYPE_NOT_ALLOWED', `Presentation scope is missing ${field}`, { field });
    }
  }
  if (!Array.isArray(scope.requestCredentialTypes) || scope.requestCredentialTypes.length === 0) {
    throw sdkError('REQUEST_TYPE_NOT_ALLOWED', 'Presentation scope must include at least one request credential type', {
      scopeId: scope.scopeId,
    });
  }
}

function scopedRequestCredentialTypes(
  appConfig: PresentationAppConfig,
): Array<{ scope: PresentationScopeConfig; entry: RequestCredentialTypeConfig }> {
  if (!Array.isArray(appConfig.scopes)) return [];
  return appConfig.scopes.flatMap((scope) =>
    Array.isArray(scope?.requestCredentialTypes)
      ? scope.requestCredentialTypes.map((entry) => ({ scope, entry }))
      : [],
  );
}

function validateTargetCredentialPolicies(entry: Extract<RequestCredentialTypeConfig, { presentationRequestMode: 'configDriven' }>): void {
  const policies = entry.targetCredentialPolicies;
  if (policies === undefined) return;
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'targetCredentialPolicies must be an object', {
      requestType: entry.type,
    });
  }

  for (const target of entry.targetCredentialType) {
    if (!policies[target]) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential policy is required for every selected target', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
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
  policy: TargetCredentialPolicyConfig | undefined,
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

function validateTargetCredentialCapabilities(entry: Extract<RequestCredentialTypeConfig, { presentationRequestMode: 'developerDefined' }>): void {
  const capabilities = entry.targetCredentialCapabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'targetCredentialCapabilities must be an object', { requestType: entry.type });
  }
  for (const target of entry.targetCredentialType) {
    const capability = capabilities[target];
    if (!capability) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Target credential capabilities are required for every selected target', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    const sources = capability.allowedPersonalDataSources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => !personalDataSourceValues.has(source))) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'allowedPersonalDataSources must contain supported sources', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    if (target === TargetCredentialType.Human && sources.includes(PersonalDataSource.OfficialDocument)) {
      throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'Human target capabilities cannot include officialDocument', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
    const attributes = capability.allowedAttributes;
    if (attributes === undefined) continue;
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'allowedAttributes must be an object', { requestType: entry.type, targetCredentialType: target });
    }
    if (attributes.name && !sources.some((source) => source === PersonalDataSource.PlatformUserData || source === PersonalDataSource.OfficialDocument)) {
      throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', 'name requires platformUserData or officialDocument capability', { requestType: entry.type, targetCredentialType: target });
    }
    for (const attribute of ['profilePicture', 'profileUrl', 'socialMedia'] as const) {
      if (attributes[attribute] && !sources.includes(PersonalDataSource.PlatformUserData)) {
        throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', `${attribute} requires platformUserData capability`, { requestType: entry.type, targetCredentialType: target });
      }
    }
    validateCapabilityValues(entry.type, target, attributes);
  }
  for (const target of Object.keys(capabilities)) {
    if (!entry.targetCredentialType.includes(target as TargetCredentialTypeValue)) {
      throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', 'Target credential capability target is not selected for request type', {
        requestType: entry.type,
        targetCredentialType: target,
      });
    }
  }
}

function validateCapabilityValues(requestType: string, target: TargetCredentialTypeValue, attributes: AttributeInput): void {
  if (attributes.socialMedia !== undefined) {
    const values = normalizeStringList(attributes.socialMedia, (item) => item.toLowerCase());
    if (values.length === 0 || values.some((value) => !supportedSocialMediaValues.has(value))) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'allowed socialMedia values must be supported and non-empty', { requestType, targetCredentialType: target });
    }
  }
  if (attributes.nationality !== undefined) {
    if (target !== TargetCredentialType.Uniqueness) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality capability requires UniquenessVerifiableCredential', { requestType, targetCredentialType: target });
    }
    const values = normalizeStringList(attributes.nationality, (item) => item.toUpperCase());
    if (values.length === 0 || values.some((value) => !supportedNationalityValues.has(value))) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'allowed nationality values must be supported and non-empty', { requestType, targetCredentialType: target });
    }
  }
}

function configuredAttributes(policy: TargetCredentialPolicyConfig): AttributeInput {
  return {
    ...(policy.personalDataSource === PersonalDataSource.PlatformUserData
      ? { name: true, profilePicture: true, socialMedia: ['facebook', 'linemessage'] }
      : {}),
    ...(policy.attributes ?? {}),
  };
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
