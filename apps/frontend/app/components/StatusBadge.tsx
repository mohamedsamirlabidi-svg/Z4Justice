const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  pending: { bg: '#fef9c3', color: '#854d0e' },
  paid: { bg: '#dcfce7', color: '#166534' },
  overdue: { bg: '#fee2e2', color: '#991b1b' },
  cancelled: { bg: '#f3f4f6', color: '#4b5563' },
  processed: { bg: '#dbeafe', color: '#1e40af' },
  processing: { bg: '#dbeafe', color: '#1e40af' },
  failed: { bg: '#fee2e2', color: '#991b1b' },
  queued: { bg: '#f3f4f6', color: '#374151' },
  draft: { bg: '#f1f5f9', color: '#334155' },
  sent: { bg: '#dbeafe', color: '#1e40af' },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_COLORS[(status || '').toLowerCase()] || STATUS_COLORS.queued;
  return (
    <span
      style={{
        ...style,
        padding: '3px 10px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {status}
    </span>
  );
}
