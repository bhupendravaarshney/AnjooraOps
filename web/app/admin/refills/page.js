import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { refreshRefillStatuses } from '@/lib/refills';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function Refills({ searchParams }) {
  const staff = await requireStaff({ roles: ['OPERATIONS'] });
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const cursor = parseCursor(params?.cursor);
  await refreshRefillStatuses();
  const { rows } = await query(`
    SELECT r.*,c.name customer_name,o.public_id source_order_public_id,n.public_id next_order_public_id
    FROM refills r JOIN customers c ON c.id=r.customer_id JOIN orders o ON o.id=r.source_order_id
    LEFT JOIN orders n ON n.id=r.next_order_id
    WHERE ($1='' OR r.public_id ILIKE $1||'%' OR o.public_id ILIKE $1||'%' OR lower(c.name) LIKE lower($1)||'%')
      AND ($2::date IS NULL OR (r.due_date,r.id)>($2::date,$3::uuid))
    ORDER BY r.due_date,r.id LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Retry-safe retention</div><h1>Refills</h1><p className="muted">Each decision is locked and creates at most one next order.</p></div></div>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Refill, order, or customer"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/refills">Clear</a>}</form><div style={{height:16}}/>
    <div className="table-wrap"><table><thead><tr><th>Refill</th><th>Customer</th><th>Source order</th><th>Due</th><th>Status</th><th>Reminder</th><th>Decision</th><th>Action</th></tr></thead><tbody>{rows.slice(0,50).map((refill) => <tr key={refill.id}>
      <td>{refill.public_id}</td><td>{refill.customer_name}</td><td>{refill.source_order_public_id}</td><td>{String(refill.due_date).slice(0,10)}</td><td><Status value={refill.status}/></td>
      <td>{refill.last_reminded_at ? new Date(refill.last_reminded_at).toLocaleString() : '—'}</td><td>{refill.decision || '—'}{refill.next_order_public_id && <div className="small muted">Next: {refill.next_order_public_id}</div>}</td>
      <td>{!['ORDERED','CLOSED'].includes(refill.status) && <form action="/api/admin/refills" method="post" className="row"><input type="hidden" name="refill_id" value={refill.id}/><input type="hidden" name="expected_status" value={refill.status}/><button className="btn secondary" name="decision" value="SAME">Same</button><button className="btn secondary" name="decision" value="MODIFY">Modify</button><button className="btn danger" name="decision" value="STOP">Stop</button></form>}</td>
    </tr>)}</tbody></table></div>
    {rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/refills?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(rows[49], 'due_date') }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
