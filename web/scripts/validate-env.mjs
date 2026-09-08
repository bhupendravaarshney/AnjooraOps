function fail(message) { throw new Error(`Configuration error: ${message}`); }
function strong(name) {
  const value = process.env[name] || '';
  if (value.length < 32 || /replace|change.?me|example/i.test(value)) fail(`${name} must be an independent random value of at least 32 characters.`);
}
function httpsUrl(name) {
  let parsed;
  try { parsed = new URL(process.env[name]); } catch { fail(`${name} must be an absolute URL.`); }
  if (parsed.protocol !== 'https:' || /\.example(?:\.|$)|\.test$/i.test(parsed.hostname)) fail(`${name} must be a real HTTPS endpoint.`);
  return parsed;
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required.');
if (process.env.NODE_ENV === 'production') {
  strong('SESSION_SECRET');
  strong('ANJOORA_INTEGRATION_SECRET');
  strong('CRON_SECRET');
  if (new Set([process.env.SESSION_SECRET, process.env.ANJOORA_INTEGRATION_SECRET, process.env.CRON_SECRET]).size !== 3) {
    fail('SESSION_SECRET, ANJOORA_INTEGRATION_SECRET, and CRON_SECRET must be different values.');
  }
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  let parsed;
  try { parsed = new URL(appUrl); } catch { fail('APP_URL must be an absolute URL.'); }
  const localProfile = process.env.DEPLOYMENT_PROFILE === 'local';
  if (localProfile) {
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) fail('The local deployment profile is only valid on localhost.');
  } else {
    if (parsed.protocol !== 'https:') fail('APP_URL must use HTTPS in production.');
    if (/anjoora:anjoora@/i.test(process.env.DATABASE_URL)) fail('Default database credentials cannot be used in production.');
    if (process.env.ENABLE_DEMO_FORM === 'true') fail('ENABLE_DEMO_FORM must be false in production.');
    if (process.env.REQUIRE_STAFF_MFA !== 'true') fail('REQUIRE_STAFF_MFA must be true in production.');
    if (!/^\d{10,15}$/.test(process.env.ANJOORA_WHATSAPP_NUMBER || '')) fail('ANJOORA_WHATSAPP_NUMBER must contain a valid country-code number.');

    const paymentProvider = String(process.env.PAYMENT_PROVIDER || '').trim().toUpperCase();
    if (!paymentProvider) fail('PAYMENT_PROVIDER must be explicitly set to MANUAL or the configured external provider.');
    if (paymentProvider !== 'MANUAL') {
      strong('PAYMENT_WEBHOOK_SECRET');
      httpsUrl('PAYMENT_LINK_BASE_URL');
    }

    const whatsappKeys = ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
    const configuredWhatsAppKeys = whatsappKeys.filter((name) => Boolean(process.env[name]));
    if (configuredWhatsAppKeys.length && configuredWhatsAppKeys.length !== whatsappKeys.length) {
      fail(`Meta WhatsApp configuration is partial; set all of ${whatsappKeys.join(', ')} or none of them.`);
    }
    if (configuredWhatsAppKeys.length) {
      strong('WHATSAPP_VERIFY_TOKEN');
      strong('WHATSAPP_APP_SECRET');
    }
  }
}
