import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConsultationPayload, CONSENT_VERSION } from '../lib/consultation-input.js';

function valid(overrides = {}) {
  return {
    submission_id: '6c983b5e-47f9-4f45-9a33-0cff55a70c63',
    name: 'Ananya Test', whatsapp: '+91 98765 43210', city: 'Test City',
    language: 'Hinglish', best_time_to_message: 'Afternoon',
    primary_concern: 'Sleep', concerns: ['Calm', 'Sleep'],
    preferred_format: 'Botanical infusion', safety_flags: ['none'],
    questionnaire_version: '1.0', safety_screen_version: '1.0', consent: true,
    ...overrides,
  };
}

test('normalizes the integrated Anjoora payload', () => {
  const result = normalizeConsultationPayload(valid());
  assert.equal(result.submissionId, valid().submission_id);
  assert.equal(result.phone, '919876543210');
  assert.equal(result.context.primaryConcern.label, 'Sleep');
  assert.equal(result.context.concerns.length, 2);
  assert.equal(result.context.safety.outcome, 'CLEAR');
  assert.equal(CONSENT_VERSION, '2026-09-v1');
});

test('requires server-supported schema, consent and versions', () => {
  assert.throws(() => normalizeConsultationPayload(valid({ consent: false })), /Consent/);
  assert.throws(() => normalizeConsultationPayload(valid({ questionnaire_version: '9.0' })), /Unsupported questionnaire/);
  assert.throws(() => normalizeConsultationPayload(valid({ injected: 'value' })), /Unexpected field/);
});

test('rejects invalid identity fields', () => {
  assert.throws(() => normalizeConsultationPayload(valid({ name: '1' })), /name/);
  assert.throws(() => normalizeConsultationPayload(valid({ whatsapp: '12345' })), /valid Indian mobile/);
  assert.throws(() => normalizeConsultationPayload(valid({ submission_id: 'retry-me' })), /UUID/);
});
