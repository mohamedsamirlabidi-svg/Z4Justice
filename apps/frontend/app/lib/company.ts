export type CompanyKey = 'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS' | 'UNKNOWN';

export const companyLabels: Record<Exclude<CompanyKey, 'UNKNOWN'>, string> = {
  ACROBATE_SOLUTION: 'Acrobate Solution',
  GAMESTREAM_ATLAS: 'GameStream ATLAS'
};

export function detectCompany(input?: string | null): CompanyKey {
  const value = (input ?? '').toLowerCase();
  if (!value) return 'UNKNOWN';

  if (value.includes('acrobate')) return 'ACROBATE_SOLUTION';
  if (value.includes('gamestream') || value.includes('atlas')) return 'GAMESTREAM_ATLAS';

  return 'UNKNOWN';
}

export function detectCompanyFromAny(values: Array<string | null | undefined>): CompanyKey {
  for (const value of values) {
    const detected = detectCompany(value);
    if (detected !== 'UNKNOWN') return detected;
  }
  return 'UNKNOWN';
}

export function getCompanyLabel(key: CompanyKey): string {
  if (key === 'UNKNOWN') return 'Unknown';
  return companyLabels[key];
}
