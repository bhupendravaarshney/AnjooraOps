import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import { STAFF_ROLES } from '@/lib/staff-policy';
import AdminShell from '@/app/components/AdminShell';

export const dynamic = 'force-dynamic';

const roleAccess = {
  ADMIN: 'All tabs, including Staff and Privacy',
  VAIDYA: 'Dashboard, Consultations, and WhatsApp',
  OPERATIONS: 'Dashboard, Consultations, Orders, Inventory, Batches, Dispatch, and Refills',
  SUPPORT: 'Dashboard and WhatsApp only',
};

const statusMessages = {
  created: 'Staff account created. The temporary password must be changed at first login.',
  updated: 'Staff identity and role updated; existing sessions were revoked.',
  reset: 'Temporary password reset; existing sessions were revoked and password rotation is required.',
  deactivated: 'Staff account deactivated and all sessions revoked.',
};

export default async function StaffManagement({ searchParams }) {
  const currentStaff = await requireStaff({ capability: 'STAFF_MANAGEMENT' });
  const params = await searchParams;
  const staff = (await query(`
    SELECT id,email,name,role,active,must_rotate_password,
           last_login_at,password_changed_at,created_at,updated_at
    FROM staff_users
    ORDER BY active DESC,lower(name),lower(email),id
  `)).rows;

  return <AdminShell staff={currentStaff}>
    <div className="section-head"><div><div className="tag">LIVE-001 · named access</div><h1>Staff accounts</h1><p className="muted">Only administrators can create users or change access. Permissions are enforced again by every protected API.</p></div></div>
    {statusMessages[params?.status] && <div className="notice">{statusMessages[params.status]}</div>}
    <div style={{height:16}}/>
    <div className="grid grid-2">
      <section className="card stack">
        <div><h2>Create named user</h2><p className="muted">Do not use shared role mailboxes. Send the temporary password through an approved private channel.</p></div>
        <form action="/api/admin/staff" method="post" className="stack">
          <input type="hidden" name="action" value="create"/>
          <div className="grid grid-2">
            <div className="field"><label>Full name</label><input name="name" required minLength={2} maxLength={100} autoComplete="off"/></div>
            <div className="field"><label>Named email</label><input name="email" type="email" required maxLength={254} autoComplete="off"/></div>
            <div className="field"><label>Role</label><select name="role" defaultValue="SUPPORT">{STAFF_ROLES.map((role) => <option value={role} key={role}>{role}</option>)}</select></div>
            <div className="field"><label>Temporary password</label><input name="temporary_password" type="password" required minLength={12} maxLength={128} autoComplete="new-password"/></div>
          </div>
          <div className="small muted">Password requires uppercase, lowercase, number, and symbol. New users must rotate it before accessing operational tabs.</div>
          <button className="btn">Create staff user</button>
        </form>
      </section>
      <section className="card">
        <h2>Role access</h2>
        <div className="table-wrap"><table><thead><tr><th>Role</th><th>Visible and permitted tabs</th></tr></thead><tbody>
          {STAFF_ROLES.map((role) => <tr key={role}><td><strong>{role}</strong></td><td>{roleAccess[role]}</td></tr>)}
        </tbody></table></div>
      </section>
    </div>
    <div style={{height:20}}/>
    <div className="table-wrap"><table>
      <thead><tr><th>User</th><th>Security</th><th>Update identity/access</th><th>Reset password</th><th>Account</th></tr></thead>
      <tbody>{staff.map((user) => {
        const isCurrent = user.id === currentStaff.id;
        return <tr key={user.id}>
          <td><strong>{user.name}</strong><div className="small muted">{user.email}</div><div className="small muted">{user.role}</div></td>
          <td>{user.active ? 'Active' : 'Inactive'} · {user.must_rotate_password ? 'Rotation required' : 'Password rotated'}<div className="small muted">Last login: {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}</div></td>
          <td>{isCurrent ? <span className="small muted">Use your account pages for your own security settings.</span> : <form action="/api/admin/staff" method="post" className="stack">
            <input type="hidden" name="action" value="update"/><input type="hidden" name="staff_id" value={user.id}/>
            <div className="field"><input name="name" defaultValue={user.name} required minLength={2} maxLength={100} aria-label={`Name for ${user.email}`}/></div>
            <div className="field"><select name="role" defaultValue={user.role} aria-label={`Role for ${user.email}`}>{STAFF_ROLES.map((role) => <option value={role} key={role}>{role}</option>)}</select></div>
            <button className="btn secondary" disabled={!user.active}>Save and revoke sessions</button>
          </form>}</td>
          <td>{!isCurrent && user.active ? <form action="/api/admin/staff" method="post" className="stack">
            <input type="hidden" name="action" value="reset"/><input type="hidden" name="staff_id" value={user.id}/>
            <div className="field"><input name="temporary_password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" placeholder="New temporary password" aria-label={`Temporary password for ${user.email}`}/></div>
            <button className="btn secondary">Reset and revoke sessions</button>
          </form> : '—'}</td>
          <td>{isCurrent ? <span className="small muted">Current account</span> : user.active ? <form action="/api/admin/staff" method="post">
            <input type="hidden" name="action" value="deactivate"/><input type="hidden" name="staff_id" value={user.id}/>
            <button className="btn danger">Deactivate</button>
          </form> : <span className="small muted">Use the approved recovery CLI to reactivate.</span>}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </AdminShell>;
}
