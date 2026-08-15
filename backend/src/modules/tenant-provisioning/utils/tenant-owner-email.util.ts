import { isEmail } from 'class-validator';

export const TENANT_OWNER_EMAIL_MAX_LENGTH = 255;

export function normalizeTenantOwnerEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized.length === 0 ||
    normalized.length > TENANT_OWNER_EMAIL_MAX_LENGTH ||
    !isEmail(normalized)
  ) {
    return null;
  }

  return normalized;
}
