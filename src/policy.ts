import { PersonalDataSource, PolicyTier, PresentationPath, SemanticAttributePath, TargetCredentialType } from './constants.js';
import { sdkError } from './errors.js';
import type { AttributeInput, PolicyTierValue, PresentationAppConfig, PresentationPolicy, SemanticAttribute, TargetCredentialTypeValue } from './types.js';

const policyTierValues = new Set<string>(Object.values(PolicyTier));
const personalDataSourceValues = new Set<string>(Object.values(PersonalDataSource));
const targetCredentialTypeValues = new Set<string>(Object.values(TargetCredentialType));
const sdkKnownPaths = new Set<string>(Object.values(PresentationPath).map(normalizePresentationPath));

export function assertPolicy(policy: PresentationPolicy): void {
  if (!policy || typeof policy !== 'object') {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', 'policy is required');
  }
  if (!policyTierValues.has(policy.tier)) {
    throw sdkError('POLICY_VALUE_NOT_ALLOWED', `Unsupported policy.tier: ${String(policy.tier)}`, {
      field: 'policy.tier',
      value: policy.tier,
    });
  }
  if (!personalDataSourceValues.has(policy.personalDataSource)) {
    throw sdkError(
      'POLICY_VALUE_NOT_ALLOWED',
      `Unsupported policy.personalDataSource: ${String(policy.personalDataSource)}`,
      { field: 'policy.personalDataSource', value: policy.personalDataSource },
    );
  }
}

export function assertTargetCredentialTypeValue(value: string): asserts value is TargetCredentialTypeValue {
  if (!targetCredentialTypeValues.has(value)) {
    throw sdkError('TARGET_VC_TYPE_NOT_ALLOWED', `Unsupported target credential type: ${value}`, {
      targetCredentialType: value,
      allowed: [...targetCredentialTypeValues],
    });
  }
}

export function normalizeStringList(value: unknown, mapper: (item: string) => string = (item) => item): string[] {
  if (value === undefined || value === false || value === null) return [];
  if (value === true) return [];
  const raw = Array.isArray(value) ? value : [value];
  return Array.from(new Set(raw.map((item) => mapper(String(item).trim())).filter((item) => item.length > 0)));
}

export function assertAttributePolicy(params: {
  attributes: AttributeInput;
  policy: PresentationPolicy;
  targetCredentialType: TargetCredentialTypeValue;
}): void {
  const { attributes, policy, targetCredentialType } = params;
  assertPolicy(policy);
  assertTargetCredentialTypeValue(targetCredentialType);

  if (attributes.name && policy.personalDataSource === PersonalDataSource.NotProvided) {
    throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', 'notProvided cannot request name', {
      attribute: 'name',
      source: policy.personalDataSource,
    });
  }

  for (const attribute of ['profilePicture', 'profileUrl', 'socialMedia'] as const) {
    if (attributes[attribute] && policy.personalDataSource !== PersonalDataSource.PlatformUserData) {
      throw sdkError('ATTRIBUTE_SOURCE_NOT_ALLOWED', `${attribute} requires platformUserData`, {
        attribute,
        source: policy.personalDataSource,
      });
    }
  }

  if (attributes.nationality && policy.tier !== PolicyTier.Uniqueness) {
    throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality requires uniqueness policy tier', {
      attribute: 'nationality',
      tier: policy.tier,
    });
  }
  if (attributes.nationality && targetCredentialType !== TargetCredentialType.Uniqueness) {
    throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality requires UniquenessVerifiableCredential', {
      attribute: 'nationality',
      targetCredentialType,
    });
  }
}

export function attributesFromPaths(paths: string[]): AttributeInput {
  const pathSet = new Set(paths.map(normalizePresentationPath));
  return {
    name: pathSet.has(SemanticAttributePath.name),
    profilePicture: pathSet.has(SemanticAttributePath.profilePicture),
    profileUrl: pathSet.has(SemanticAttributePath.profileUrl),
    socialMedia: pathSet.has(SemanticAttributePath.socialMedia),
    nationality: pathSet.has(SemanticAttributePath.nationality),
  };
}

export function isAllowedPathByRegistry(appConfig: PresentationAppConfig | undefined, path: string): boolean {
  if (!appConfig) return true;
  const normalized = normalizePresentationPath(path);
  return appConfig.allowedPresentationPaths.map(normalizePresentationPath).includes(normalized);
}

export function assertPathKnownToSdk(path: string): void {
  const normalized = normalizePresentationPath(path);
  if (!sdkKnownPaths.has(normalized)) {
    throw sdkError('PD_PATH_NOT_ALLOWED', `Presentation Definition path is not supported by this SDK: ${path}`, {
      path,
      supportedPaths: [...sdkKnownPaths],
    });
  }
}

export function normalizePresentationPath(path: string): string {
  return path === PresentationPath.TypeCompat ? PresentationPath.Type : path;
}

export function semanticAttributePath(attribute: SemanticAttribute): string {
  return SemanticAttributePath[attribute];
}

export function tierFromCredentialTypes(types: string[]): PolicyTierValue | undefined {
  if (types.includes(TargetCredentialType.Uniqueness)) return PolicyTier.Uniqueness;
  if (types.includes(TargetCredentialType.Human)) return PolicyTier.Human;
  return undefined;
}
