export default function Status({ value }) {
  const v = String(value || '—');
  const c = /DELIVERED|APPROVED|COMPLETED|READY/.test(v) ? 'ok' : /FAILED|CLOSED|ON_HOLD/.test(v) ? 'danger' : /PENDING|CLARIFICATION|HUMAN|NEW/.test(v) ? 'warn' : '';
  return <span className={`status ${c}`}>{v.replaceAll('_',' ')}</span>;
}
