import { cookies } from 'next/headers';
import { withTransaction } from '@/lib/db';
import { hashPassword, verifyPassword, randomToken, tokenHash } from '@/lib/security';
import { uuid } from '@/lib/ids';
import { sessionCookieOptions } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { errorResponse, hashPrivateValue, requestIp, requireSameOrigin, sameOriginRedirect } from '@/lib/http';

const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-password');

export async function POST(request) {
  try {
    requireSameOrigin(request);
    const ip = requestIp(request);
    await enforceRateLimit({ scope: 'staff-login-ip', key: ip, limit: 20, windowSeconds: 900 });
    const form = await request.formData();
    const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 254);
    const password = String(form.get('password') || '');
    const result = await withTransaction(async (db) => {
      const user = (await db.query(`SELECT * FROM staff_users WHERE email=$1 AND active=true FOR UPDATE`, [email])).rows[0];
      if (user?.locked_until && new Date(user.locked_until) > new Date()) {
        await writeAudit(db, { request, entityType: 'STAFF_USER', entityId: user.id, action: 'LOGIN', outcome: 'REJECTED', payload: { reason: 'LOCKED' } });
        return { ok: false, error: 'locked' };
      }
      const passwordValid = verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
      if (!user || !passwordValid) {
        if (user) {
          const failures = Number(user.failed_login_count || 0) + 1;
          await db.query(`
            UPDATE staff_users SET failed_login_count=$1,
              locked_until=CASE WHEN $1>=5 THEN now()+interval '15 minutes' ELSE NULL END,
              updated_at=now() WHERE id=$2
          `, [failures, user.id]);
        }
        await writeAudit(db, {
          request, entityType: 'STAFF_USER', entityId: user?.id || null, action: 'LOGIN', outcome: 'REJECTED',
          payload: { reason: 'CREDENTIALS_FAILED', email_hash: hashPrivateValue(email) },
        });
        return { ok: false, error: 'credentials' };
      }

      const token = randomToken();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);
      await db.query(`DELETE FROM sessions WHERE expires_at<=now()`);
      await db.query(`
        DELETE FROM sessions WHERE id IN (
          SELECT id FROM sessions WHERE staff_user_id=$1 ORDER BY created_at DESC OFFSET 4
        )
      `, [user.id]);
      await db.query(`
        INSERT INTO sessions(id,staff_user_id,token_hash,expires_at,ip_hash,user_agent_hash)
        VALUES($1,$2,$3,$4,$5,$6)
      `, [
        uuid(), user.id, tokenHash(token), expiresAt, hashPrivateValue(ip),
        hashPrivateValue(request.headers.get('user-agent') || 'unknown'),
      ]);
      await db.query(`UPDATE staff_users SET failed_login_count=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE id=$1`, [user.id]);
      await writeAudit(db, {
        request, staffId: user.id, entityType: 'STAFF_USER', entityId: user.id,
        action: 'LOGIN', resultingState: 'AUTHENTICATED', payload: { authentication: 'PASSWORD' },
      });
      return { ok: true, token, expiresAt, mustRotate: user.must_rotate_password };
    });
    if (!result.ok) return sameOriginRedirect(`/admin/login?error=${result.error}`);
    const jar = await cookies();
    jar.set({ ...sessionCookieOptions(result.expiresAt), value: result.token });
    const destination = result.mustRotate ? '/admin/account/password' : '/admin';
    return sameOriginRedirect(destination);
  } catch (error) {
    return errorResponse(error);
  }
}
