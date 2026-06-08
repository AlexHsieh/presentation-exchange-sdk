import { createHash } from 'node:crypto';

export function canonicalizePresentationDefinition(input: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return value;
  };

  return JSON.stringify(normalize(input));
}

export function normalizePresentationDefinition<T>(input: T): T {
  return JSON.parse(canonicalizePresentationDefinition(input)) as T;
}

export function encodePresentationDefinition(definition: unknown): string {
  return Buffer.from(canonicalizePresentationDefinition(definition), 'utf8').toString('base64url');
}

export function computePresentationDefinitionHash(definition: unknown): string {
  return createHash('sha256').update(encodePresentationDefinition(definition)).digest('hex');
}
