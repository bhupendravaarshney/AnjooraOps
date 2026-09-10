import { requireStaff } from '@/lib/auth';
import { encryptSecret, generateMfaSecret } from '@/lib/security';

export const dynamic = 'force-dynamic';

export default async function MfaPage({ searchParams }) {
  const staff = await requireStaff({ allowMfaEnrollment: true });
  const params = await searchParams;
  const secret = staff.mfa_enabled ? null : generateMfaSecret();
  const setup = secret ? encryptSecret(secret) : null;
  const issuer = encodeURIComponent('ANJOORA Ops');
  const label = encodeURIComponent(`ANJOORA Ops:${staff.email}`);
  const uri = secret ? `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` : null;
  return <main className="container" style={{maxWidth:720,paddingTop:48}}><section className="card stack">
    <div><div className="brand">ANJOORA</div><div className="tag">Account security</div></div><h1>Multi-factor authentication</h1>
    {params?.error && <div className="error">The authenticator code could not be verified.</div>}
    {staff.mfa_enabled ? <>
      <div className="notice">Authenticator MFA is enabled.</div>
      {process.env.REQUIRE_STAFF_MFA === 'true' ?
        <p className="muted">MFA is mandatory. If you lose the authenticator, an administrator must use the audited account-recovery procedure.</p> :
      <form action="/api/auth/mfa" method="post" className="stack"><input type="hidden" name="action" value="disable"/>
        <div className="field"><label>Current password</label><input type="password" name="password" required autoComplete="current-password"/></div>
        <div className="field"><label>Current authenticator code</label><input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required/></div>
        <button className="btn danger">Disable MFA</button>
      </form>}
    </> : <>
      <p>Add this account in an authenticator app using the setup key or the URI, then enter the current six-digit code.</p>
      <div className="notice"><strong>Setup key</strong><br/><code>{secret}</code></div>
      <details><summary>Show authenticator URI</summary><code style={{overflowWrap:'anywhere'}}>{uri}</code></details>
      <form action="/api/auth/mfa" method="post" className="stack"><input type="hidden" name="action" value="enable"/><input type="hidden" name="setup" value={setup}/>
        <div className="field"><label>Authenticator code</label><input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code"/></div>
        <button className="btn">Verify and enable MFA</button>
      </form>
    </>}
  </section></main>;
}
