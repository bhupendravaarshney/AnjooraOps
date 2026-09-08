import { cookies } from 'next/headers';
import { requireStaff, SESSION_COOKIE } from '@/lib/auth';
import { query } from '@/lib/db';
import { tokenHash } from '@/lib/security';
import AdminShell from '@/app/components/AdminShell';

export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  const staff = await requireStaff();
  const jar = await cookies();
  const currentHash = tokenHash(jar.get(SESSION_COOKIE)?.value || '');
  const sessions = (await query(`
    SELECT id,token_hash,created_at,last_seen_at,expires_at
    FROM sessions WHERE staff_user_id=$1 AND expires_at>now()
    ORDER BY last_seen_at DESC
  `, [staff.id])).rows;
  return <AdminShell staff={staff}><div className="section-head"><div><div className="tag">Account security</div><h1>Active sessions</h1></div></div>
    <section className="card"><div className="table-wrap"><table><thead><tr><th>Created</th><th>Last seen</th><th>Expires</th><th></th></tr></thead><tbody>{sessions.map((session) => {
      const current = session.token_hash === currentHash;
      return <tr key={session.id}><td>{new Date(session.created_at).toLocaleString()}</td><td>{new Date(session.last_seen_at).toLocaleString()}</td><td>{new Date(session.expires_at).toLocaleString()}</td><td>{current ? <strong>Current</strong> : <form action="/api/auth/sessions" method="post"><input type="hidden" name="session_id" value={session.id}/><button className="btn danger">Revoke</button></form>}</td></tr>;
    })}</tbody></table></div></section>
  </AdminShell>;
}
