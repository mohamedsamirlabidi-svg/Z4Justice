type KpiCardProps = {
  title: string;
  value: string | number;
  icon?: string;
  trend?: string;
  color?: string;
};

export function KpiCard({ title, value, icon, trend, color }: KpiCardProps) {
  return (
    <div
      style={{
        background: 'var(--color-card)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-card)',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        borderLeft: `4px solid ${color || 'var(--color-primary-light)'}`,
      }}
    >
      <span style={{ color: 'var(--color-text-muted)', fontSize: '13px', fontWeight: 500 }}>
        {icon ? `${icon} ` : ''}
        {title}
      </span>
      <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text)' }}>{value}</span>
      {trend ? <span style={{ fontSize: '12px', color: 'var(--color-success)' }}>{trend}</span> : null}
    </div>
  );
}
