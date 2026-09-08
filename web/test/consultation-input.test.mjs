import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsultationInputError,
  normalizeConcerns,
  normalizeSafetyFlags,
} from '../lib/consultation-input.js';
import { buildFolio } from '../lib/folio.js';

test('legacy concern becomes the single primary concern', () => {
  assert.deepEqual(normalizeConcerns({ concern: 'Sleep' }), [
    { key: 'sleep', label: 'Sleep', isPrimary: true, position: 1 },
  ]);
});

test('multiple concerns preserve selection order, primary choice, and remove duplicates', () => {
  assert.deepEqual(normalizeConcerns({
    primary_concern: 'Sleep',
    concerns: ['Calm', 'Sleep', ' calm ', 'Energy'],
  }), [
    { key: 'calm', label: 'Calm', isPrimary: false, position: 1 },
    { key: 'sleep', label: 'Sleep', isPrimary: true, position: 2 },
    { key: 'energy', label: 'Energy', isPrimary: false, position: 3 },
  ]);
});

test('more than four unique concerns is rejected', () => {
  assert.throws(
    () => normalizeConcerns({ concerns: ['Calm', 'Sleep', 'Focus', 'Energy', 'Digestion'] }),
    ConsultationInputError,
  );
});

test('four unique concerns is accepted', () => {
  const concerns = normalizeConcerns({ concerns: ['Calm', 'Sleep', 'Focus', 'Energy'] });
  assert.equal(concerns.length, 4);
  assert.equal(concerns.filter((item) => item.isPrimary).length, 1);
});

test('primary concern must be part of the submitted concern list', () => {
  assert.throws(
    () => normalizeConcerns({ primary_concern: 'Sleep', concerns: ['Calm', 'Focus'] }),
    /primary_concern must also be present/,
  );
});

test('none records a completed clear safety screen', () => {
  const safety = normalizeSafetyFlags({ safety_flags: ['none'] });
  assert.equal(safety.outcome, 'CLEAR');
  assert.equal(safety.reviewRequired, false);
  assert.equal(safety.urgent, false);
});

test('review and urgent safety flags set operational indicators', () => {
  const safety = normalizeSafetyFlags({ safety_flags: ['medication', 'urgent-chest'] });
  assert.equal(safety.outcome, 'URGENT');
  assert.equal(safety.reviewRequired, true);
  assert.equal(safety.urgent, true);
  assert.deepEqual(safety.flags.map((item) => item.position), [1, 2]);
});

test('missing safety screen is explicitly review-required', () => {
  const safety = normalizeSafetyFlags({});
  assert.equal(safety.flags[0].code, 'not-provided');
  assert.equal(safety.reviewRequired, true);
});

test('none cannot contradict another safety flag', () => {
  assert.throws(
    () => normalizeSafetyFlags({ safety_flags: ['none', 'allergy'] }),
    /cannot be combined/,
  );
});

test('folio makes primary, linked, and safety context explicit', () => {
  const folio = buildFolio({
    name: 'QA User',
    whatsapp: '+91 70000 00000',
    concerns: [
      { label: 'Calm', isPrimary: false },
      { label: 'Sleep', isPrimary: true },
      { label: 'Focus', isPrimary: false },
    ],
    safety_flags: [
      { label: 'Takes prescription medicines regularly' },
    ],
    safety_review_required: true,
    urgent_safety_flag: false,
    safety_screen_version: '1.0',
  });

  assert.match(folio, /Primary concern: Sleep/);
  assert.match(folio, /Linked concerns: Calm, Focus/);
  assert.match(folio, /Human safety review required before recommendation/);
  assert.match(folio, /Takes prescription medicines regularly/);
});
