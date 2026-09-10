import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, roleCan } from '../lib/rbac.js';

test('role capability matrix enforces least privilege', () => {
  for (const capability of CAPABILITIES) assert.equal(roleCan('ADMIN', capability), true);
  assert.equal(roleCan('VAIDYA', 'CLINICAL_REVIEW'), true);
  assert.equal(roleCan('VAIDYA', 'OPERATIONS'), false);
  assert.equal(roleCan('OPERATIONS', 'OPERATIONS'), true);
  assert.equal(roleCan('OPERATIONS', 'CLINICAL_REVIEW'), false);
  assert.equal(roleCan('SUPPORT', 'WHATSAPP'), true);
  assert.equal(roleCan('SUPPORT', 'CONSULTATIONS_VIEW'), false);
  assert.equal(roleCan('SUPPORT', 'PRIVACY'), false);
  assert.equal(roleCan('SUPPORT', 'STAFF_MANAGEMENT'), false);
  assert.equal(roleCan('VAIDYA', 'STAFF_MANAGEMENT'), false);
  assert.equal(roleCan('OPERATIONS', 'STAFF_MANAGEMENT'), false);
  assert.equal(roleCan('UNKNOWN', 'DASHBOARD'), false);
  assert.equal(roleCan('ADMIN', 'UNKNOWN'), false);
});
