const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export const LOCAL_JOB_SCHEDULE = Object.freeze([
  Object.freeze({ target: 'outbox', intervalMs: 60_000 }),
  Object.freeze({ target: 'refills', intervalMs: 24 * 60 * 60_000 }),
  Object.freeze({ target: 'maintenance', intervalMs: 24 * 60 * 60_000 }),
]);

export function operationalJobUrl(pathname, configuredUrl, env = process.env) {
  let url;
  try {
    url = new URL(pathname, configuredUrl);
  } catch {
    throw new Error('APP_URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('APP_URL must be an absolute HTTP(S) URL.');
  }
  const localComposeTarget = env.DEPLOYMENT_PROFILE === 'local' && url.hostname === 'app';
  const localTarget = loopbackHosts.has(url.hostname) || localComposeTarget;
  if (env.NODE_ENV === 'production' && !localTarget && url.protocol !== 'https:') {
    throw new Error('Operational jobs must call an HTTPS APP_URL in production.');
  }
  return url;
}

export function assertLocalSchedulerEnvironment(env = process.env) {
  if (env.DEPLOYMENT_PROFILE !== 'local' || env.GO_LIVE === 'true') {
    throw new Error('The bundled scheduler is local-only; production must use the approved external scheduler and alerting service.');
  }
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is required.');
  const configuredUrl = env.APP_URL || env.NEXT_PUBLIC_APP_URL;
  if (!configuredUrl) throw new Error('APP_URL is required.');
  const url = operationalJobUrl('/api/health', configuredUrl, env);
  if (!loopbackHosts.has(url.hostname) && url.hostname !== 'app') {
    throw new Error('The bundled scheduler may target only localhost or the local Compose app service.');
  }
}
