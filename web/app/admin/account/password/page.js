import { requireStaff } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function PasswordPage({ searchParams }) {
  const staff = await requireStaff({ allowPasswordRotation: true });
  const params = await searchParams;
  return <main className="container" style={{maxWidth:680,paddingTop:48}}><section className="card stack">
    <div><div className="brand">ANJOORA</div><div className="tag">Account security</div></div>
    <h1>Change password</h1>
    {staff.must_rotate_password && <div className="notice">You must replace the bootstrap password before using the console.</div>}
    {params?.error && <div className="error">Password change failed. Check the current password and policy.</div>}
    <form action="/api/auth/password" method="post" className="stack">
      <div className="field"><label>Current password</label><input name="current_password" type="password" autoComplete="current-password" required/></div>
      <div className="field"><label>New password</label><input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/><div className="small muted">12–128 characters with uppercase, lowercase, number, and symbol.</div></div>
      <div className="field"><label>Confirm new password</label><input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></div>
      <button className="btn">Change password and sign out all sessions</button>
    </form>
  </section></main>;
}
