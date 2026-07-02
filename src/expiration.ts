import { sdkError } from './errors.js';

export const PRESENTATION_REQUEST_MAX_EXPIRES_IN_MS = 60 * 60 * 1000;
export const PRESENTATION_DEFINITION_MAX_EXPIRATION_MINIMUM_MS = 30 * 24 * 60 * 60 * 1000;

export type ExpirationDurationInput = {
  minutes?: number;
  hours?: number;
  days?: number;
};

export type ExpiresInOptions = {
  now?: Date | string;
};

export function expiresIn(duration: ExpirationDurationInput, options: ExpiresInOptions = {}): Date {
  const now = parseDate(options.now ?? new Date(), 'now', 'PRESENTATION_DEFINITION_INVALID');
  const milliseconds =
    durationPart(duration.minutes, 60 * 1000, 'minutes') +
    durationPart(duration.hours, 60 * 60 * 1000, 'hours') +
    durationPart(duration.days, 24 * 60 * 60 * 1000, 'days');

  if (milliseconds <= 0) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', 'expiration duration must be greater than zero', { duration });
  }

  return new Date(now.getTime() + milliseconds);
}

export function assertFutureWithin(
  value: Date | string,
  options: {
    field: string;
    maxMs: number;
    code: 'PRESENTATION_DEFINITION_INVALID' | 'PRESENTATION_REQUEST_EXPIRED';
    now?: Date | string;
  },
): Date {
  const now = parseDate(options.now ?? new Date(), 'now', options.code);
  const date = parseDate(value, options.field, options.code);
  const deltaMs = date.getTime() - now.getTime();

  if (deltaMs <= 0) {
    throw sdkError(options.code, `${options.field} must be in the future`, {
      [options.field]: date.toISOString(),
      now: now.toISOString(),
    });
  }

  if (deltaMs > options.maxMs) {
    throw sdkError(options.code, `${options.field} exceeds maximum allowed expiration window`, {
      [options.field]: date.toISOString(),
      now: now.toISOString(),
      maxMs: options.maxMs,
    });
  }

  return date;
}

function durationPart(value: number | undefined, multiplier: number, field: keyof ExpirationDurationInput): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw sdkError('PRESENTATION_DEFINITION_INVALID', `expiration duration ${field} must be a non-negative number`, {
      [field]: value,
    });
  }
  return value * multiplier;
}

function parseDate(
  value: Date | string,
  field: string,
  code: 'PRESENTATION_DEFINITION_INVALID' | 'PRESENTATION_REQUEST_EXPIRED',
): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw sdkError(code, `${field} must be a valid date-time`, { value });
  }
  return date;
}
