import { withTransaction } from '@/lib/db';
import { HttpError, hashPrivateValue } from '@/lib/http';

export async function enforceRateLimit({ scope, key, limit, windowSeconds }) {
  const keyHash = hashPrivateValue(`${scope}:${key}`);
  return withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${scope}:${keyHash}`]);
    const { rows } = await db.query(`
      SELECT count(*)::int AS attempts,
             EXTRACT(EPOCH FROM (MIN(created_at) + ($3 * interval '1 second') - now()))::int AS retry_after
      FROM rate_limit_events
      WHERE scope=$1 AND key_hash=$2 AND created_at > now() - ($3 * interval '1 second')
    `, [scope, keyHash, windowSeconds]);
    if (rows[0].attempts >= limit) {
      const error = new HttpError(429, 'Too many requests. Please try again later.', 'RATE_LIMITED');
      error.retryAfter = Math.max(1, Number(rows[0].retry_after || windowSeconds));
      throw error;
    }
    await db.query(`INSERT INTO rate_limit_events(scope,key_hash) VALUES($1,$2)`, [scope, keyHash]);
    return { remaining: Math.max(0, limit - rows[0].attempts - 1) };
  });
}

