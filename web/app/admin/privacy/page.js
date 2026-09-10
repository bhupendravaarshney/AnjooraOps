import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function PrivacyPage({ searchParams }) {
  const staff = await requireStaff({ capability: 'PRIVACY' });
  const verificationMethod = process.env.PRIVACY_IDENTITY_VERIFICATION_METHOD || 'the approved manual procedure';
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const cursor = parseCursor(params?.cursor);
  const requests = (await query(`
    SELECT dsr.*,c.public_id customer_public_id,c.name customer_name,c.legal_hold
    FROM data_subject_requests dsr LEFT JOIN customers c ON c.id=dsr.customer_id
    WHERE ($1='' OR dsr.public_id ILIKE $1||'%' OR c.public_id ILIKE $1||'%' OR lower(c.name) LIKE lower($1)||'%')
      AND ($2::timestamptz IS NULL OR (dsr.requested_at,dsr.id)<($2::timestamptz,$3::uuid))
    ORDER BY dsr.requested_at DESC,dsr.id DESC LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null])).rows;
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Data lifecycle</div><h1>Privacy requests</h1></div></div>
    <section className="card"><h2>Record verified request</h2><form action="/api/admin/privacy" method="post" className="stack">
      <input type="hidden" name="action" value="create"/>
      <div className="grid grid-2"><div className="field"><label>Customer public ID or exact phone</label><input name="customer_ref" required/></div><div className="field"><label>Request type</label><select name="request_type"><option>ACCESS</option><option>CORRECTION</option><option>ANONYMIZATION</option></select></div></div>
      <label className="row"><input type="checkbox" name="identity_verified" value="yes" required style={{width:'auto'}}/> I verified the requester’s identity using: {verificationMethod}.</label>
      <div className="field"><label>Non-sensitive verification note</label><input name="notes" maxLength={500}/></div>
      <button className="btn">Record request</button>
    </form></section>
    <div style={{height:20}}/>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Request, customer ID, or customer"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/privacy">Clear</a>}</form><div style={{height:16}}/>
    <div className="table-wrap"><table><thead><tr><th>Request</th><th>Customer</th><th>Type</th><th>Status</th><th>Requested</th><th>Actions</th></tr></thead><tbody>{requests.slice(0,50).map((item) => <tr key={item.id}>
      <td>{item.public_id}</td><td>{item.customer_name || 'Anonymized'}<div className="small muted">{item.customer_public_id || '—'}{item.legal_hold ? ' · LEGAL HOLD' : ''}</div></td><td>{item.request_type}</td><td><Status value={item.status}/></td><td>{new Date(item.requested_at).toLocaleString()}</td>
      <td><div className="stack">{item.request_type === 'ACCESS' && <a className="btn outline" href={`/api/admin/privacy/export?request_id=${item.id}`}>Export</a>}{!['COMPLETED','REJECTED'].includes(item.status) && <form action="/api/admin/privacy" method="post" className="stack"><input type="hidden" name="action" value="complete"/><input type="hidden" name="request_id" value={item.id}/><input type="hidden" name="expected_status" value={item.status}/>{item.request_type === 'CORRECTION' && <><input name="name" placeholder="Corrected name (optional)"/><input name="city" placeholder="Corrected city (optional)"/><input name="language" placeholder="Corrected language (optional)"/></>}<button className="btn secondary">Complete</button></form>}{item.customer_public_id && <form action="/api/admin/privacy" method="post" className="stack"><input type="hidden" name="action" value="legal_hold"/><input type="hidden" name="customer_ref" value={item.customer_public_id}/><input type="hidden" name="expected_legal_hold" value={String(Boolean(item.legal_hold))}/><input type="hidden" name="hold" value={item.legal_hold ? 'no' : 'yes'}/><input name="reason" required maxLength={500} placeholder={item.legal_hold ? 'Reason to release hold' : 'Reason to apply hold'}/><button className={item.legal_hold ? 'btn secondary' : 'btn danger'}>{item.legal_hold ? 'Release legal hold' : 'Apply legal hold'}</button></form>}</div></td>
    </tr>)}</tbody></table></div>
    {requests.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/privacy?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(requests[49], 'requested_at') }).toString()}`}>Next page</a></div>}
    <p className="small muted">Enter at least one corrected field before completing a correction. Anonymization is blocked when a legal hold is active.</p>
  </AdminShell>;
}
