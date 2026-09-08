import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { tokenHash } from '@/lib/security';
import { SESSION_COOKIE } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { errorResponse, requireSameOrigin } from '@/lib/http';

export async function POST(request) {
  try {
    requireSameOrigin(request);
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) {
      await withTransaction(async (db) => {
        const session = (await db.query(`SELECT * FROM sessions WHERE token_hash=$1 FOR UPDATE`, [tokenHash(token)])).rows[0];
        if (session) {
          await db.query(`DELETE FROM sessions WHERE id=$1`, [session.id]);
          await writeAudit(db, { request, staffId: session.staff_user_id, entityType: 'STAFF_USER', entityId: session.staff_user_id, action: 'LOGOUT', priorState: 'AUTHENTICATED', resultingState: 'SIGNED_OUT' });
        }
      });
    }
    jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: new Date(0) });
    return NextResponse.redirect(new URL('/admin/login', request.url), 303);
  } catch (error) {
    return errorResponse(error);
  }
}
