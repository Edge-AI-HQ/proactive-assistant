import { config } from '../config.js';
import { listAuthAllowlist } from '../db.js';
import type { AuthAllowlistRecord } from '../types.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const unique = (values: string[]): string[] => Array.from(new Set(values));

const getDomainFromEmail = (email: string): string | null => {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) return null;
  return email.slice(atIndex + 1);
};

export const normalizeDomain = (value: string): string => value.trim().toLowerCase().replace(/^@+/, '');

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export const isValidDomain = (value: string): boolean => domainPattern.test(value);

export const isValidEmail = (value: string): boolean => emailPattern.test(value);

const normalizeDomainEntry = (entry: AuthAllowlistRecord): AuthAllowlistRecord | null => {
  const normalizedValue = normalizeDomain(entry.value);
  if (!normalizedValue || !isValidDomain(normalizedValue)) return null;
  return { ...entry, value: normalizedValue };
};

const normalizeEmailEntry = (entry: AuthAllowlistRecord): AuthAllowlistRecord | null => {
  const normalizedValue = normalizeEmail(entry.value);
  if (!normalizedValue || !isValidEmail(normalizedValue)) return null;
  return { ...entry, value: normalizedValue };
};

export interface AuthPolicySnapshot {
  defaultAllowedDomains: string[];
  defaultAllowedEmails: string[];
  customDomainEntries: AuthAllowlistRecord[];
  customEmailEntries: AuthAllowlistRecord[];
  effectiveAllowedDomains: string[];
  effectiveAllowedEmails: string[];
}

export const getAuthPolicySnapshot = (): AuthPolicySnapshot => {
  const entries = listAuthAllowlist();

  const defaultAllowedDomains = unique(
    config.auth.allowedDomains.map(normalizeDomain).filter((value) => value && isValidDomain(value))
  );
  const defaultAllowedEmails = unique(
    config.auth.allowedEmails.map(normalizeEmail).filter((value) => value && isValidEmail(value))
  );

  const customDomainEntries = entries
    .filter((entry) => entry.kind === 'domain')
    .map(normalizeDomainEntry)
    .filter((entry): entry is AuthAllowlistRecord => Boolean(entry));

  const customEmailEntries = entries
    .filter((entry) => entry.kind === 'email')
    .map(normalizeEmailEntry)
    .filter((entry): entry is AuthAllowlistRecord => Boolean(entry));

  const effectiveAllowedDomains = unique([...defaultAllowedDomains, ...customDomainEntries.map((entry) => entry.value)]);
  const effectiveAllowedEmails = unique([...defaultAllowedEmails, ...customEmailEntries.map((entry) => entry.value)]);

  return {
    defaultAllowedDomains,
    defaultAllowedEmails,
    customDomainEntries,
    customEmailEntries,
    effectiveAllowedDomains,
    effectiveAllowedEmails
  };
};

export const isEmailAllowedForAuth = (email: string): boolean => {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) return false;

  const domain = getDomainFromEmail(normalizedEmail);
  if (!domain) return false;

  const policy = getAuthPolicySnapshot();
  const allowedEmailSet = new Set(policy.effectiveAllowedEmails);
  if (allowedEmailSet.has(normalizedEmail)) return true;

  const allowedDomainSet = new Set(policy.effectiveAllowedDomains);
  return allowedDomainSet.has(domain);
};
