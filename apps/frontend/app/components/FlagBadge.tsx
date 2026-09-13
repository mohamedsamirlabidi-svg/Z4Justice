/**
 * Flag color badge for invoice monitoring (F1c).
 * Matches computeFlag() output: green | yellow | orange | red | none.
 */

type FlagColor = 'green' | 'yellow' | 'orange' | 'red' | 'none';

const FLAG_STYLES: Record<FlagColor, { bg: string; color: string; label: string; dot: string }> = {
  green: { bg: '#dcfce7', color: '#166534', label: 'Paid', dot: '#16a34a' },
  yellow: { bg: '#fef9c3', color: '#854d0e', label: 'Yellow', dot: '#eab308' },
  orange: { bg: '#ffedd5', color: '#9a3412', label: 'Orange', dot: '#f97316' },
  red: { bg: '#fee2e2', color: '#991b1b', label: 'Red', dot: '#dc2626' },
  none: { bg: '#f3f4f6', color: '#4b5563', label: 'On time', dot: '#9ca3af' },
};

function normalize(status: string): FlagColor {
  return (['green', 'yellow', 'orange', 'red', 'none'] as const).includes(status as FlagColor)
    ? (status as FlagColor)
    : 'none';
}

export function FlagBadge({ status, label }: { status: string; label?: string }) {
  const key = normalize(status);
  const s = FLAG_STYLES[key];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 20,
        background: s.bg,
        color: s.color,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot }} />
      {label ?? s.label}
    </span>
  );
}
