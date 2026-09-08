export function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw || /[^\d+\s().-]/.test(raw) || (raw.match(/\+/g) || []).length > 1 || (raw.includes('+') && !raw.startsWith('+'))) {
    return '';
  }

  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 10) {
    if (!/^[6-9]\d{9}$/.test(digits)) return '';
    digits = `91${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    const national = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(national)) return '';
    digits = `91${national}`;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    if (!/^[6-9]\d{9}$/.test(digits.slice(2))) return '';
  } else if (!/^[1-9]\d{7,14}$/.test(digits)) {
    return '';
  }

  return digits;
}

export function isValidPhone(value) {
  return Boolean(normalizePhone(value));
}
