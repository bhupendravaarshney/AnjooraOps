import test from 'node:test';
import assert from 'node:assert/strict';
import { metaWebhookValues, valueBelongsToConfiguredPhone } from '../lib/meta-webhook.js';

test('extracts only WhatsApp message changes', () => {
  const value = { metadata: { phone_number_id: '12345' }, messages: [{ id: 'wamid.1' }] };
  assert.deepEqual(metaWebhookValues({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'account_update', value: {} }, { field: 'messages', value }] }],
  }), [value]);
  assert.deepEqual(metaWebhookValues({ object: 'page', entry: [] }), []);
});

test('filters webhook events to the configured production phone-number ID', () => {
  assert.equal(valueBelongsToConfiguredPhone({ metadata: { phone_number_id: '12345' } }, '12345'), true);
  assert.equal(valueBelongsToConfiguredPhone({ metadata: { phone_number_id: '99999' } }, '12345'), false);
  assert.equal(valueBelongsToConfiguredPhone({}, '12345'), false);
  assert.equal(valueBelongsToConfiguredPhone({}, ''), true);
});
