import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { tokenHash } from '@/lib/security';
import { HttpError, requireSameOrigin } from '@/lib/http';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production'
  ? '__Host-anjoora_session'
  : 'anjoora_session';

export const STAFF_ROLES = Object.freeze(['ADMIN', 'VAIDYA', 'OPERATIONS', 'SUPPORT']);

export async function getStaff() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const { rows } = await query(`
    SELECT u.id, u.email, u.name, u.role, u.must_rotate_password, u.mfa_enabled,
           s.id session_id, s.expires_at
    FROM sessions s
    JOIN staff_users u ON u.id = s.staff_user_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true
    LIMIT 1
  `, [tokenHash(token)]);
  const staff = rows[0] || null;
  if (staff) {
    query(`UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now()-interval '5 minutes'`, [staff.session_id]).catch(() => {});
  }
  return staff;
}

export async function requireStaff({ request = null, roles = null, allowPasswordRotation = false, allowMfaEnrollment = false } = {}) {
  const staff = await getStaff();
  if (!staff) {
    if (request) throw new HttpError(401, 'Authentication is required.', 'AUTH_REQUIRED');
    redirect('/admin/login');
  }
  if (staff.must_rotate_password && !allowPasswordRotation) {
    if (request) throw new HttpError(403, 'Password rotation is required.', 'PASSWORD_ROTATION_REQUIRED');
    redirect('/admin/account/password');
  }
  if (process.env.REQUIRE_STAFF_MFA === 'true' && !staff.mfa_enabled && !allowMfaEnrollment) {
    if (request) throw new HttpError(403, 'MFA enrollment is required.', 'MFA_ENROLLMENT_REQUIRED');
    redirect('/admin/account/mfa');
  }
  if (roles?.length && staff.role !== 'ADMIN' && !roles.includes(staff.role)) {
    if (request) throw new HttpError(403, 'You do not have permission for this action.', 'FORBIDDEN');
    redirect('/admin?forbidden=1');
  }
  if (request) requireSameOrigin(request);
  return staff;
}

export function sessionCookieOptions(expiresAt) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
