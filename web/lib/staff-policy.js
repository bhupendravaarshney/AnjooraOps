export const STAFF_ROLES = Object.freeze(['ADMIN', 'VAIDYA', 'OPERATIONS', 'SUPPORT']);

export function normalizeStaffEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('A valid STAFF_EMAIL is required.');
  }
  return email;
}

export function normalizeStaffRole(value) {
  const role = String(value || '').trim().toUpperCase();
  if (!STAFF_ROLES.includes(role)) throw new Error(`STAFF_ROLE must be one of ${STAFF_ROLES.join(', ')}.`);
  return role;
}

export function normalizeStaffName(value) {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 100) throw new Error('STAFF_NAME must contain 2-100 characters.');
  return name;
}

export function parseStaffRegister(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('The staff register must be a non-empty JSON array.');
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Staff register entry ${index + 1} must be an object.`);
    }
    const email = normalizeStaffEmail(entry.email);
    if (seen.has(email)) throw new Error(`Staff register contains duplicate email ${email}.`);
    seen.add(email);
    return {
      email,
      name: normalizeStaffName(entry.name),
      role: normalizeStaffRole(entry.role),
    };
  });
}

function looksLikeTestAccount(account) {
  const email = String(account.email || '').toLowerCase();
  const localPart = email.split('@')[0];
  const name = String(account.name || '').toLowerCase();
  return /(^|[.@+-])(test|demo|sample|bootstrap)([.@+-]|$)/.test(email)
    || /@(example\.(?:com|org|net)|[^@]+\.test)$/.test(email)
    || /^(?:admin|administrator|support|operations|ops|team|help|info|contact|staff|owner|vaidya)$/.test(localPart)
    || /^(?:anjoora staff|anjoora admin|test|demo|support team|operations team|admin)(?:\s|$)/.test(name);
}

export function staffComplianceFindings(accounts, {
  expectedRegister = null,
  requireMfa = true,
} = {}) {
  const findings = [];
  const rows = Array.isArray(accounts) ? accounts : [];
  const active = rows.filter((account) => account.active === true);

  if (active.length === 0) findings.push('No active staff account exists.');
  for (const account of active) {
    const label = account.email || account.id || 'unknown staff account';
    if (!STAFF_ROLES.includes(account.role)) findings.push(`${label} has an invalid role.`);
    if (account.must_rotate_password) findings.push(`${label} still has a temporary password.`);
    if (requireMfa && !account.mfa_enabled) findings.push(`${label} has not enrolled authenticator MFA.`);
    if (looksLikeTestAccount(account)) findings.push(`${label} appears to be a shared, bootstrap, demo, or test account.`);
  }

  if (expectedRegister) {
    const expected = parseStaffRegister(expectedRegister);
    const expectedByEmail = new Map(expected.map((entry) => [entry.email, entry]));
    const activeByEmail = new Map(active.map((entry) => [String(entry.email || '').toLowerCase(), entry]));
    for (const entry of expected) {
      const account = activeByEmail.get(entry.email);
      if (!account) {
        findings.push(`Approved staff account ${entry.email} is missing or inactive.`);
        continue;
      }
      if (String(account.name || '').trim() !== entry.name) findings.push(`${entry.email} does not match the approved staff name.`);
      if (account.role !== entry.role) findings.push(`${entry.email} has role ${account.role}, expected ${entry.role}.`);
    }
    for (const account of active) {
      if (!expectedByEmail.has(String(account.email || '').toLowerCase())) {
        findings.push(`${account.email || account.id} is active but absent from the approved staff register.`);
      }
    }
  }

  return findings;
}
