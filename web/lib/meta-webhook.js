export function metaWebhookValues(payload) {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
  return payload.entry
    .flatMap((entry) => Array.isArray(entry?.changes) ? entry.changes : [])
    .filter((change) => change?.field === 'messages' && change?.value)
    .map((change) => change.value);
}

export function valueBelongsToConfiguredPhone(value, configuredPhoneNumberId) {
  const expected = String(configuredPhoneNumberId || '').trim();
  if (!expected) return true;
  return String(value?.metadata?.phone_number_id || '').trim() === expected;
}
