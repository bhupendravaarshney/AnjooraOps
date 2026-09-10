import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_RELEASE_CHECKS, REQUIRED_SIGNOFFS, releaseEvidenceFindings } from '../lib/release-evidence.js';

function record(extra = {}) {
  return { passed: true, owner: 'Named Owner', evidence_ref: 'ticket://ANJ-1', verified_at: '2026-09-09T10:00:00Z', ...extra };
}

function validEvidence() {
  return {
    evidence_version: 1,
    release_candidate: 'anjoora-2026.09.09.1',
    staging_url: 'https://staging.anjoora.in',
    payment_provider: 'CERTIFIEDPAY',
    payment_adapter_id: 'certifiedpay-v1',
    whatsapp_business_account_id: '987654321098765',
    consent_version: '2026-09-approved-v1',
    privacy_approval_id: 'LEGAL/PRIVACY/1',
    approved_rpo_hours: 24,
    approved_rto_minutes: 240,
    checks: Object.fromEntries(REQUIRED_RELEASE_CHECKS.map((name) => [name, record()])),
    signoffs: Object.fromEntries(REQUIRED_SIGNOFFS.map((name) => [name, { ...record(), approved: true, passed: undefined }])),
  };
}

test('accepts complete, matching, dated release evidence', () => {
  assert.deepEqual(releaseEvidenceFindings(validEvidence(), {
    releaseCandidate: 'anjoora-2026.09.09.1',
    paymentProvider: 'CERTIFIEDPAY', paymentAdapterId: 'certifiedpay-v1',
    whatsappBusinessAccountId: '987654321098765', consentVersion: '2026-09-approved-v1',
    privacyApprovalId: 'LEGAL/PRIVACY/1',
    rpoHours: 24, rtoMinutes: 240, now: new Date('2026-09-09T12:00:00Z'),
  }), []);
});

test('rejects missing checks, mismatched approvals, and unsigned owners', () => {
  const evidence = validEvidence();
  evidence.checks.whatsapp_scenarios_passed.passed = false;
  evidence.signoffs.privacy_owner.approved = false;
  evidence.signoffs.release_owner.verified_at = '2026-09-09T09:59:59Z';
  evidence.release_candidate = 'another-release';
  evidence.payment_provider = 'OTHERPAY';
  const findings = releaseEvidenceFindings(evidence, {
    releaseCandidate: 'anjoora-2026.09.09.1',
    paymentProvider: 'CERTIFIEDPAY', paymentAdapterId: 'certifiedpay-v1',
    whatsappBusinessAccountId: '987654321098765', consentVersion: '2026-09-approved-v1',
    privacyApprovalId: 'LEGAL/PRIVACY/1',
    rpoHours: 24, rtoMinutes: 240, now: new Date('2026-09-09T12:00:00Z'),
  });
  assert.ok(findings.some((finding) => finding.includes('whatsapp_scenarios_passed')));
  assert.ok(findings.some((finding) => finding.includes('privacy_owner')));
  assert.ok(findings.some((finding) => finding.includes('release_owner') && finding.includes('before the latest release check')));
  assert.ok(findings.some((finding) => finding.includes('release_candidate')));
  assert.ok(findings.some((finding) => finding.includes('payment_provider')));
});
