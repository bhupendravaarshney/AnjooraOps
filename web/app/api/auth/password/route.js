import { cookies } from 'next/headers';
import { requireStaff, SESSION_COOKIE } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { hashPassword, passwordPolicyError, verifyPassword } from '@/lib/security';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';

export async function POST(request) {
  try {
    const staff = await requireStaff({ request, allowPasswordRotation: true });
    const form = await request.formData();
    const currentPassword = String(form.get('current_password') || '');
    const newPassword = String(form.get('new_password') || '');
    const confirmation = String(form.get('confirm_password') || '');
    const policyError = passwordPolicyError(newPassword);
    if (policyError) throw new HttpError(422, policyError, 'PASSWORD_POLICY');
    if (newPassword !== confirmation) throw new HttpError(422, 'Password confirmation does not match.', 'PASSWORD_MISMATCH');
    await withTransaction(async (db) => {
      const user = (await db.query(`SELECT * FROM staff_users WHERE id=$1 FOR UPDATE`, [staff.id])).rows[0];
      if (!user || !verifyPassword(currentPassword, user.password_hash)) throw new HttpError(403, 'Current password is invalid.', 'INVALID_PASSWORD');
      if (verifyPassword(newPassword, user.password_hash)) throw new HttpError(422, 'New password must differ from the current password.', 'PASSWORD_REUSED');
      await db.query(`
        UPDATE staff_users SET password_hash=$1,password_changed_at=now(),must_rotate_password=false,
          failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$2
      `, [hashPassword(newPassword), staff.id]);
      await writeAudit(db, { request, staffId: staff.id, entityType: 'STAFF_USER', entityId: staff.id, action: 'PASSWORD_CHANGED', payload: { sessions_revoked: true } });
      await db.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [staff.id]);
    });
    const jar = await cookies();
    jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(0) });
    return sameOriginRedirect('/admin/login?password=changed');
  } catch (error) {
    if (error instanceof HttpError) return sameOriginRedirect('/admin/account/password?error=1');
    return errorResponse(error);
  }
}
