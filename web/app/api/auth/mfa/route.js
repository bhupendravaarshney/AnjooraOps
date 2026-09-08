import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { decryptSecret, encryptSecret, verifyPassword, verifyTotp } from '@/lib/security';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse } from '@/lib/http';

export async function POST(request) {
  try {
    const staff = await requireStaff({ request, allowMfaEnrollment: true });
    const form = await request.formData();
    const action = String(form.get('action') || '');
    const code = String(form.get('code') || '');
    if (!['enable', 'disable'].includes(action)) throw new HttpError(422, 'Unsupported MFA action.', 'UNKNOWN_ACTION');
    await withTransaction(async (db) => {
      const user = (await db.query(`SELECT * FROM staff_users WHERE id=$1 FOR UPDATE`, [staff.id])).rows[0];
      if (action === 'enable') {
        if (user.mfa_enabled) return;
        let secret;
        try { secret = decryptSecret(String(form.get('setup') || '')); } catch { throw new HttpError(422, 'MFA setup expired or is invalid.', 'INVALID_MFA_SETUP'); }
        if (!verifyTotp(secret, code)) throw new HttpError(422, 'Authenticator code is invalid.', 'INVALID_MFA_CODE');
        await db.query(`UPDATE staff_users SET mfa_enabled=true,mfa_secret_encrypted=$1,updated_at=now() WHERE id=$2`, [encryptSecret(secret), staff.id]);
        await writeAudit(db, { request, staffId: staff.id, entityType: 'STAFF_USER', entityId: staff.id, action: 'MFA_ENABLED' });
      } else {
        if (!user.mfa_enabled) return;
        const password = String(form.get('password') || '');
        let validCode = false;
        try { validCode = verifyTotp(decryptSecret(user.mfa_secret_encrypted), code); } catch { /* handled below */ }
        if (!verifyPassword(password, user.password_hash) || !validCode) throw new HttpError(403, 'Password or authenticator code is invalid.', 'INVALID_MFA_PROOF');
        await db.query(`UPDATE staff_users SET mfa_enabled=false,mfa_secret_encrypted=NULL,updated_at=now() WHERE id=$1`, [staff.id]);
        await writeAudit(db, { request, staffId: staff.id, entityType: 'STAFF_USER', entityId: staff.id, action: 'MFA_DISABLED' });
      }
    });
    return NextResponse.redirect(new URL('/admin', request.url), 303);
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.redirect(new URL('/admin/account/mfa?error=1', request.url), 303);
    return errorResponse(error);
  }
}
