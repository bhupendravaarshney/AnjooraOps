import { requireStaff } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';

export async function POST(request) {
  try {
    const staff = await requireStaff({ request });
    const form = await request.formData();
    const sessionId = String(form.get('session_id') || '');
    if (!sessionId) throw new HttpError(422, 'session_id is required.', 'VALIDATION_ERROR');
    await withTransaction(async (db) => {
      const session = (await db.query(`SELECT * FROM sessions WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
      if (!session) return;
      if (session.staff_user_id !== staff.id && staff.role !== 'ADMIN') throw new HttpError(403, 'You cannot revoke this session.', 'FORBIDDEN');
      await db.query(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
      await writeAudit(db, { request, staffId: staff.id, entityType: 'STAFF_USER', entityId: session.staff_user_id, action: 'SESSION_REVOKED', payload: { session_id: sessionId } });
    });
    return sameOriginRedirect('/admin/account/sessions');
  } catch (error) {
    return errorResponse(error);
  }
}
