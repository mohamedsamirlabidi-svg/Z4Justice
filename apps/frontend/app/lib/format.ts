/**
 * Tunisian Dinar (TND) currency formatting utilities.
 * Display format: "1 868,900 DT" (French-Tunisian notation)
 */

export function formatTND(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return '0,000 DT';
  }
  return (
    new Intl.NumberFormat('fr-TN', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    }).format(amount) + ' DT'
  );
}

/**
 * Format a date for display.
 */
export function formatDate(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('fr-TN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Get display-safe string or '-' fallback.
 */
export function display(value?: string | null): string {
  const cleaned = (value ?? '').trim();
  return cleaned.length > 0 ? cleaned : '-';
}

/**
 * Status badge CSS class name.
 */
export function statusClass(status: string): string {
  const normalized = (status || 'draft').toLowerCase();
  return `status-badge status-${normalized}`;
}

/**
 * Normalize tax rate: if > 1, treat as percentage and divide by 100.
 */
export function normalizeTaxRate(raw?: number | null): number {
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}
