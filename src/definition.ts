import { PresentationExchange, type PresentationDefinitionV2 } from '@web5/credentials';
import { PersonalDataSource, PresentationPath, TargetCredentialType } from './constants.js';
import { normalizePresentationDefinition } from './canonicalization.js';
import { sdkError } from './errors.js';
import { assertFutureWithin, PRESENTATION_DEFINITION_MAX_EXPIRATION_MINIMUM_MS } from './expiration.js';
import {
  assertAttributePolicy,
  assertPathKnownToSdk,
  attributesFromPaths,
  isAllowedPathByRegistry,
  normalizePresentationPath,
  normalizeStringList,
} from './policy.js';
import type {
  AttributeInput,
  BuildPresentationDefinitionInput,
  PresentationPolicy,
  ValidatePresentationDefinitionOptions,
} from './types.js';

type Field = NonNullable<PresentationDefinitionV2['input_descriptors'][number]['constraints']['fields']>[number];

const supportedSocialMediaValues = ['facebook', 'linemessage'] as const;
const supportedNationalityValues = ['TWN', 'USA'] as const;

export function validatePresentationDefinition(
  definition: PresentationDefinitionV2,
  options: ValidatePresentationDefinitionOptions = {},
): PresentationDefinitionV2 {
  validateWithPresentationExchange(definition);
  const paths = extractRequiredPaths(definition);
  const fields = allFields(definition);

  for (const path of paths) {
    assertPathKnownToSdk(path);
    if (!isAllowedPathByRegistry(options.appConfig, path)) {
      throw sdkError('PD_PATH_NOT_ALLOWED', `Presentation Definition path is not allowed: ${path}`, { path });
    }
  }

  if (options.mode === 'strict') {
    assertNoDuplicateSemanticPaths(fields);
  }

  if (options.targetCredentialType) {
    const typeValues = extractFilterValues(definition, PresentationPath.Type);
    if (typeValues.length === 0 || !typeValues.includes(options.targetCredentialType)) {
      throw sdkError('PRESENTATION_DEFINITION_INVALID', 'VC type filter does not match target credential type', {
        targetCredentialType: options.targetCredentialType,
        typeValues,
      });
    }
  }

  if (options.requestType) {
    const values = extractFilterValues(definition, PresentationPath.PdRequestType);
    if (values.length === 0 || !values.includes(options.requestType)) {
      throw sdkError('PRESENTATION_DEFINITION_INVALID', 'pdRequestType filter does not match request type', {
        requestType: options.requestType,
        values,
      });
    }
  }

  const expectedSubject = options.expectedSubject ?? options.subject;
  if (expectedSubject) {
    const values = extractFilterValues(definition, PresentationPath.SubjectId);
    if (values.length === 0 || !values.includes(expectedSubject)) {
      throw sdkError('PRESENTATION_DEFINITION_INVALID', 'subject filter does not match expected subject', {
        expectedSubject,
        values,
      });
    }
  }

  if (options.policy && options.targetCredentialType) {
    validatePersonalDataSourceFilter(definition, options.policy);
    const attributes = attributesFromPaths(paths);
    assertAttributePolicy({
      attributes,
      policy: options.policy,
      targetCredentialType: options.targetCredentialType,
    });
    validateNationalityFilters(definition, options.policy, options.targetCredentialType);
  }

  if (options.supportedSocialMedia) {
    validateSocialMediaFilters(definition, options.supportedSocialMedia);
  }

  validateExpirationMinimum(definition);
  return normalizePresentationDefinition(definition);
}

export function buildPresentationDefinition(input: BuildPresentationDefinitionInput): PresentationDefinitionV2 {
  const attributes = input.attributes ?? {};
  const definition = buildDefinition({
    id: input.id,
    name: input.name,
    purpose: input.purpose,
    fields: buildFields({
      attributes,
      policy: input.policy,
      targetCredentialType: input.targetCredentialType,
      requestType: input.requestType,
      subject: input.subject,
      expirationMinimum: input.expirationMinimum,
    }),
  });

  return validatePresentationDefinition(definition, {
    mode: 'strict',
    requestType: input.requestType,
    targetCredentialType: input.targetCredentialType,
    expectedSubject: input.subject,
    policy: input.policy,
  });
}

function buildDefinition(input: { id: string; name?: string; purpose?: string; fields: Field[] }): PresentationDefinitionV2 {
  return {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    input_descriptors: [
      {
        id: `${input.id}-descriptor`,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        constraints: { fields: input.fields },
      },
    ],
  };
}

function buildFields(input: {
  attributes: AttributeInput;
  policy: PresentationPolicy;
  targetCredentialType: BuildPresentationDefinitionInput['targetCredentialType'];
  requestType?: string;
  subject?: string;
  expirationMinimum?: Date | string;
}): Field[] {
  assertAttributePolicy({
    attributes: input.attributes,
    policy: input.policy,
    targetCredentialType: input.targetCredentialType,
  });

  const fields: Field[] = [
    {
      path: [PresentationPath.Type],
      filter: { type: 'string', pattern: input.targetCredentialType },
    },
    {
      path: [PresentationPath.ExpirationDate],
      filter: {
        type: 'string',
        format: 'date-time',
        ...(input.expirationMinimum ? { formatMinimum: normalizeIsoDate(input.expirationMinimum) } : {}),
      },
    },
    {
      path: [PresentationPath.IssuanceDate],
      filter: { type: 'string', format: 'date-time' },
    },
  ];

  if (input.subject) {
    fields.push({
      path: [PresentationPath.SubjectId],
      filter: { type: 'string', const: input.subject },
    });
  }

  if (input.requestType) {
    fields.push({
      path: [PresentationPath.PdRequestType],
      filter: { type: 'string', const: input.requestType },
    });
  }

  fields.push({
    path: [PresentationPath.PersonalDataSource],
    filter: { type: 'string', const: input.policy.personalDataSource },
  });

  if (input.attributes.name) fields.push({ path: [PresentationPath.Name], filter: { type: 'string' } });
  if (input.attributes.profilePicture) fields.push({ path: [PresentationPath.ProfilePicture], filter: { type: 'string', format: 'uri' } });
  if (input.attributes.profileUrl) fields.push({ path: [PresentationPath.ProfileUrl], filter: { type: 'string', format: 'uri' } });

  if (input.attributes.socialMedia) {
    const socialMedia = valuesOrDefaults(
      normalizeStringList(input.attributes.socialMedia, (item) => item.toLowerCase()),
      supportedSocialMediaValues,
      'socialMedia',
    );
    fields.push({
      path: [PresentationPath.SocialMedia],
      filter: { type: 'string', enum: socialMedia },
    });
  }

  if (input.attributes.nationality) {
    const nationality = valuesOrDefaults(
      normalizeStringList(input.attributes.nationality, (item) => item.toUpperCase()),
      supportedNationalityValues,
      'nationality',
    );
    fields.push({
      path: [PresentationPath.Nationality],
      filter: { type: 'string', enum: nationality },
    });
  }

  return fields;
}

export function validateWithPresentationExchange(definition: PresentationDefinitionV2): void {
  const validation = PresentationExchange.validateDefinition({ presentationDefinition: definition });
  const validations = Array.isArray(validation) ? validation : [validation];
  const errors = validations.filter((result: { status?: string }) => result.status !== 'info');
  if (errors.length > 0) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'Presentation Definition failed validation', { errors });
  }
}

export function extractRequiredPaths(definition: PresentationDefinitionV2): string[] {
  const paths = new Set<string>();
  for (const field of allFields(definition)) {
    const fieldPaths = Array.isArray(field.path) ? field.path : [field.path];
    for (const path of fieldPaths) {
      if (typeof path === 'string' && path.length > 0) paths.add(normalizePresentationPath(path));
    }
  }
  return [...paths].sort();
}

export function extractFilterValues(definition: PresentationDefinitionV2, path: string): string[] {
  const values: string[] = [];
  for (const field of fieldsForPath(definition, path)) {
    const filter = field.filter as Record<string, unknown> | undefined;
    const pattern = filter?.pattern;
    if (typeof pattern === 'string') values.push(...extractPatternValues(pattern));
    const constValue = filter?.const;
    if (typeof constValue === 'string') values.push(constValue);
    const enumValue = filter?.enum;
    if (Array.isArray(enumValue)) values.push(...enumValue.map((item) => String(item)));
  }
  return Array.from(new Set(values.filter(Boolean)));
}

function allFields(definition: PresentationDefinitionV2): Field[] {
  return (definition.input_descriptors ?? []).flatMap((descriptor) => descriptor.constraints?.fields ?? []);
}

function fieldsForPath(definition: PresentationDefinitionV2, path: string): Field[] {
  const normalized = normalizePresentationPath(path);
  return allFields(definition).filter((field) => {
    const fieldPaths = (Array.isArray(field.path) ? field.path : [field.path]).map((item) =>
      typeof item === 'string' ? normalizePresentationPath(item) : '',
    );
    return fieldPaths.includes(normalized);
  });
}

function assertNoDuplicateSemanticPaths(fields: Field[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    for (const path of Array.isArray(field.path) ? field.path : [field.path]) {
      if (typeof path !== 'string') continue;
      const normalized = normalizePresentationPath(path);
      if (seen.has(normalized)) {
        throw sdkError('PRESENTATION_DEFINITION_INVALID', 'Duplicate semantic Presentation Definition path', {
          path: normalized,
        });
      }
      seen.add(normalized);
    }
  }
}

function validateSocialMediaFilters(definition: PresentationDefinitionV2, supported: string[]): void {
  const supportedSet = new Set(supported.map((item) => item.toLowerCase()));
  for (const value of extractFilterValues(definition, PresentationPath.SocialMedia).map((item) => item.toLowerCase())) {
    if (!supportedSet.has(value)) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'Unsupported socialMedia filter value', { attribute: 'socialMedia', value });
    }
  }
}

function validateNationalityFilters(
  definition: PresentationDefinitionV2,
  policy: PresentationPolicy,
  targetCredentialType: string,
): void {
  const values = extractFilterValues(definition, PresentationPath.Nationality);
  if (values.length === 0) return;
  if (policy.tier !== 'uniqueness' || targetCredentialType !== TargetCredentialType.Uniqueness) {
    throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality requires uniqueness target and policy', {
      policy,
      targetCredentialType,
    });
  }
  for (const value of values) {
    if (!/^[A-Z]{3}$/.test(value)) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', 'nationality filters must be ISO 3166-1 alpha-3 codes', {
        attribute: 'nationality',
        value,
      });
    }
  }
}

function validatePersonalDataSourceFilter(definition: PresentationDefinitionV2, policy: PresentationPolicy): void {
  const values = extractFilterValues(definition, PresentationPath.PersonalDataSource);
  if (values.length !== 1) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'Presentation Definition must include exactly one personalDataSource filter', {
      values,
    });
  }
  if (!(Object.values(PersonalDataSource) as string[]).includes(values[0])) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'personalDataSource filter is unsupported', {
      value: values[0],
    });
  }
  if (values[0] !== policy.personalDataSource) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'personalDataSource filter does not match policy', {
      expected: policy.personalDataSource,
      actual: values[0],
    });
  }
}

function validateExpirationMinimum(definition: PresentationDefinitionV2): void {
  for (const field of fieldsForPath(definition, PresentationPath.ExpirationDate)) {
    const filter = field.filter as Record<string, unknown> | undefined;
    const formatMinimum = filter?.formatMinimum;
    if (formatMinimum !== undefined && (typeof formatMinimum !== 'string' || Number.isNaN(Date.parse(formatMinimum)))) {
      throw sdkError('PRESENTATION_DEFINITION_INVALID', 'expirationDate.formatMinimum must be a valid ISO date-time', {
        formatMinimum,
      });
    }
    if (typeof formatMinimum === 'string') {
      assertFutureWithin(formatMinimum, {
        field: 'expirationDate.formatMinimum',
        maxMs: PRESENTATION_DEFINITION_MAX_EXPIRATION_MINIMUM_MS,
        code: 'PRESENTATION_DEFINITION_INVALID',
      });
    }
  }
}

function valuesOrDefaults(values: string[], supportedValues: readonly string[], attribute: 'socialMedia' | 'nationality'): string[] {
  const selected = values.length > 0 ? values : [...supportedValues];
  const supportedSet = new Set<string>(supportedValues);
  for (const value of selected) {
    if (!supportedSet.has(value)) {
      throw sdkError('ATTRIBUTE_NOT_ALLOWED', `Unsupported ${attribute} filter value`, { attribute, value });
    }
  }
  return selected.sort();
}

function extractPatternValues(pattern: string): string[] {
  const exactAlternation = pattern.match(/^\^\(\?:(.*)\)\$$/);
  if (exactAlternation) {
    return exactAlternation[1].split('|').map(unescapeRegexLiteral);
  }

  const exactSingle = pattern.match(/^\^([^|]+)\$$/);
  if (exactSingle) {
    return [unescapeRegexLiteral(exactSingle[1])];
  }

  return pattern.split('|').map((item) => item.trim());
}

function unescapeRegexLiteral(value: string): string {
  return value.replace(/\\([\\^$.*+?()[\]{}|])/g, '$1');
}

function normalizeIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'expirationMinimum must be a valid date-time', { value });
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
