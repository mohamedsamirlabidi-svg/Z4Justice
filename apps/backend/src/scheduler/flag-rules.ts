/**
 * Pure flag-color computation (F1b).
 *
 * Rules (from the F1 spec):
 *   paymentStatus == 'paid'                → green (regardless of dueDate)
 *   dueDate == null AND not paid           → none  (surfaced as "missing due date" in UI)
 *   today <= dueDate                       → none  (not yet due)
 *   1 <= daysOverdue <= 7                  → yellow ("1 day up to 1 week")
 *   7 <  daysOverdue <= 30                 → orange ("more than 1 week, ≤ 1 month")
 *   daysOverdue > 30                       → red    ("more than 1 month")
 *
 * "1 month" is intentionally interpreted as 30 days for predictable boundary
 * behavior (calendar months are 28-31 days). This matches the user's spec
 * of "exactly 1 month overdue" being a testable boundary.
 *
 * daysOverdue is measured as whole UTC days between the truncated dueDate
 * and the truncated `now`. Time-of-day is ignored so an invoice due at 23:59
 * doesn't flip to overdue one second later.
 */

export type FlagColor = 'green' | 'yellow' | 'orange' | 'red' | 'none';
export type PaymentStatus = 'paid' | 'pending' | 'not_declared';

const MS_PER_DAY = 86_400_000;

function truncToUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Computes flag color. See module docstring for full rules.
 * @param now       reference "today" — inject explicit dates for deterministic tests
 * @param dueDate   invoice.dueDate, or null if not set
 * @param paymentStatus  'paid' | 'pending' | 'not_declared'
 */
export function computeFlag(
  now: Date,
  dueDate: Date | null | undefined,
  paymentStatus: string,
): FlagColor {
  if (paymentStatus === 'paid') return 'green';
  if (!dueDate) return 'none';

  const nowUtc = truncToUtcDay(now);
  const dueUtc = truncToUtcDay(dueDate);
  if (nowUtc <= dueUtc) return 'none';

  const daysOverdue = Math.floor((nowUtc - dueUtc) / MS_PER_DAY);
  if (daysOverdue <= 7) return 'yellow';
  if (daysOverdue <= 30) return 'orange';
  return 'red';
}
