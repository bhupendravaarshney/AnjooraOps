import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse } from '@/lib/http';
import { hashPassword, passwordPolicyError } from '@/lib/security';
import { normalizeStaffEmail, normalizeStaffName, normalizeStaffRole } from '@/lib/staff-policy';

const ACTIONS = new Set(['create', 'update', 'reset', 'deactivate']);

function validation(action) {
  try {
    return action();
  } catch (error) {
    throw new HttpError(422, error.message, 'VALIDATION_ERROR');
  }
}

function temporaryPassword(form) {
  const password = String(form.get('temporary_password') || '');
  const policyError = passwordPolicyError(password);
  if (policyError) throw new HttpError(422, policyError, 'INVALID_PASSWORD');
  return password;
}

export async function POST(request) {
  let administrator = null;
  let action = 'UNKNOWN';
  try {
    administrator = await requireStaff({ request, capability: 'STAFF_MANAGEMENT' });
    const form = await request.formData();
    action = String(form.get('action') || '').trim().toLowerCase();
    if (!ACTIONS.has(action)) throw new HttpError(422, 'Unsupported staff action.', 'UNKNOWN_ACTION');

    const result = await withTransaction(async (db) => {
      if (action === 'create') {
        const email = validation(() => normalizeStaffEmail(form.get('email')));
        const name = validation(() => normalizeStaffName(form.get('name')));
        const role = validation(() => normalizeStaffRole(form.get('role')));
        const password = temporaryPassword(form);
        const created = (await db.query(`
          INSERT INTO staff_users(
            id,email,name,password_hash,role,active,must_rotate_password,
            mfa_enabled,mfa_secret_encrypted
          ) VALUES($1,$2,$3,$4,$5,true,true,false,NULL)
          RETURNING id,email,name,role,active,must_rotate_password,mfa_enabled
        `, [uuid(), email, name, hashPassword(password), role])).rows[0];
        await writeAudit(db, {
          request, staffId: administrator.id, entityType: 'STAFF_USER', entityId: created.id,
          action: 'CREATED', resultingState: role,
          payload: { role, password_rotation_required: true, mfa_enrollment_required: process.env.REQUIRE_STAFF_MFA === 'true' },
        });
        return { status: 'created' };
      }

      const staffId = String(form.get('staff_id') || '').trim();
      const target = (await db.query(`SELECT * FROM staff_users WHERE id::text=$1 FOR UPDATE`, [staffId])).rows[0];
      if (!target) throw new HttpError(404, 'Staff account not found.', 'NOT_FOUND');
      if (target.id === administrator.id) {
        throw new HttpError(409, 'Use your own account pages; this screen cannot change or deactivate the current administrator.', 'SELF_MANAGEMENT_BLOCKED');
      }

      if (action === 'update') {
        const name = validation(() => normalizeStaffName(form.get('name')));
        const role = validation(() => normalizeStaffRole(form.get('role')));
        if (!target.active) throw new HttpError(409, 'Inactive accounts must use the approved recovery workflow.', 'ACCOUNT_INACTIVE');
        await db.query(`UPDATE staff_users SET name=$1,role=$2,updated_at=now() WHERE id=$3`, [name, role, target.id]);
        await db.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [target.id]);
        await writeAudit(db, {
          request, staffId: administrator.id, entityType: 'STAFF_USER', entityId: target.id,
          action: 'UPDATED', priorState: JSON.stringify({ name: target.name, role: target.role }),
          resultingState: JSON.stringify({ name, role }), payload: { sessions_revoked: true },
        });
        return { status: 'updated' };
      }

      if (action === 'reset') {
        if (!target.active) throw new HttpError(409, 'Inactive accounts must use the approved recovery workflow.', 'ACCOUNT_INACTIVE');
        const password = temporaryPassword(form);
        await db.query(`
          UPDATE staff_users
          SET password_hash=$1,must_rotate_password=true,failed_login_count=0,
              locked_until=NULL,updated_at=now()
          WHERE id=$2
        `, [hashPassword(password), target.id]);
        await db.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [target.id]);
        await writeAudit(db, {
          request, staffId: administrator.id, entityType: 'STAFF_USER', entityId: target.id,
          action: 'PASSWORD_RESET', resultingState: 'ROTATION_REQUIRED', payload: { sessions_revoked: true },
        });
        return { status: 'reset' };
      }

      await db.query(`UPDATE staff_users SET active=false,updated_at=now() WHERE id=$1`, [target.id]);
      await db.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [target.id]);
      await writeAudit(db, {
        request, staffId: administrator.id, entityType: 'STAFF_USER', entityId: target.id,
        action: 'DEACTIVATED', priorState: String(target.active), resultingState: 'false', payload: { sessions_revoked: true },
      });
      return { status: 'deactivated' };
    });

    return NextResponse.redirect(new URL(`/admin/staff?status=${result.status}`, request.url), 303);
  } catch (error) {
    if (administrator) {
      await writeAudit({ query }, {
        request, staffId: administrator.id, entityType: 'STAFF_USER', action,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    if (error?.code === '23505') return errorResponse(new HttpError(409, 'A staff account with that email already exists.', 'DUPLICATE_STAFF_EMAIL'));
    return errorResponse(error);
  }
}
