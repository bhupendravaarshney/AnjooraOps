import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStaffEmail,
  normalizeStaffRole,
  parseStaffRegister,
  staffComplianceFindings,
} from '../lib/staff-policy.js';

const compliant = {
  id: '1', email: 'asha@anjoora.in', name: 'Asha Rao', role: 'VAIDYA', active: true,
  must_rotate_password: false, mfa_enabled: true,
};

test('normalizes staff identity fields and rejects invalid roles', () => {
  assert.equal(normalizeStaffEmail(' ASHA@ANJOORA.IN '), 'asha@anjoora.in');
  assert.equal(normalizeStaffRole('vaidya'), 'VAIDYA');
  assert.throws(() => normalizeStaffRole('OWNER'), /STAFF_ROLE/);
});

test('staff compliance requires rotation, MFA, named accounts, and exact register membership', () => {
  assert.deepEqual(staffComplianceFindings([compliant], {
    expectedRegister: [{ email: compliant.email, name: compliant.name, role: compliant.role }],
  }), []);

  const findings = staffComplianceFindings([
    { ...compliant, email: 'bootstrap@example.com', name: 'ANJOORA Admin', must_rotate_password: true, mfa_enabled: false },
  ], {
    expectedRegister: [{ email: compliant.email, name: compliant.name, role: compliant.role }],
  });
  assert.ok(findings.some((finding) => finding.includes('temporary password')));
  assert.ok(findings.some((finding) => finding.includes('authenticator MFA')));
  assert.ok(findings.some((finding) => finding.includes('shared, bootstrap, demo, or test')));
  assert.ok(findings.some((finding) => finding.includes('missing or inactive')));
  assert.ok(findings.some((finding) => finding.includes('absent from the approved staff register')));
});

test('staff register rejects duplicate accounts', () => {
  assert.throws(() => parseStaffRegister([
    { email: compliant.email, name: compliant.name, role: compliant.role },
    { email: compliant.email.toUpperCase(), name: 'Other Name', role: 'SUPPORT' },
  ]), /duplicate email/);
});

test('staff compliance rejects shared role mailboxes even when other controls pass', () => {
  const findings = staffComplianceFindings([{
    id: 'shared', email: 'support@anjoora.in', name: 'Support Team', role: 'SUPPORT',
    active: true, must_rotate_password: false, mfa_enabled: true,
  }]);
  assert.ok(findings.some((finding) => finding.includes('shared, bootstrap, demo, or test account')));
});
