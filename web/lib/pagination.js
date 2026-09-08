export function parseCursor(value) {
  if (!value || typeof value !== 'string' || value.length > 256) return null;
  try {
    const [timestamp, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!timestamp || Number.isNaN(Date.parse(timestamp)) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

export function encodeCursor(row, timestampField = 'created_at') {
  return Buffer.from(JSON.stringify([new Date(row[timestampField]).toISOString(), row.id])).toString('base64url');
}

export function searchTerm(value, maximum = 80) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}
