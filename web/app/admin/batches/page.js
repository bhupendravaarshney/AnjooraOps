import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function Batches({ searchParams }) {
  const staff = await requireStaff({ capability: 'OPERATIONS' });
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const cursor = parseCursor(params?.cursor);
  const orderReference = searchTerm(params?.order, 100);
  const batches = await query(`
    SELECT b.*,o.public_id order_public_id,c.name customer_name,f.name formula_name,
           COALESCE((SELECT count(*) FROM batch_items bi WHERE bi.batch_id=b.id),0)::int material_count
    FROM batches b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=o.customer_id
    LEFT JOIN formulas f ON f.id=b.formula_id
    WHERE ($1='' OR b.public_id ILIKE $1||'%' OR o.public_id ILIKE $1||'%' OR lower(c.name) LIKE lower($1)||'%')
      AND ($2::timestamptz IS NULL OR (b.created_at,b.id)<($2::timestamptz,$3::uuid))
    ORDER BY b.created_at DESC,b.id DESC LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Controlled preparation</div><h1>Batches</h1></div></div>
    <section className="card"><h2>Create batch from paid personalised order</h2><form action="/api/admin/batches" method="post" className="row">
      <input type="hidden" name="action" value="create"/><input type="hidden" name="expected_status" value="PAID"/>
      <input name="order_ref" required defaultValue={orderReference} placeholder="Paid order public ID" maxLength={100}/>
      <input name="wastage_percent" type="number" min="0" max="25" step="0.001" defaultValue="0" aria-label="Wastage percent" required/>
      <button className="btn">Create order-sized requirements</button>
    </form></section>
    <div style={{height:20}}/>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Batch, order, or customer"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/batches">Clear</a>}</form><div style={{height:16}}/>
    <div className="table-wrap"><table><thead><tr><th>Batch</th><th>Order</th><th>Customer</th><th>Formula</th><th>Production</th><th>Materials</th><th>Status</th><th>Action</th></tr></thead><tbody>{batches.rows.slice(0,50).map((batch) => <tr key={batch.id}>
      <td>{batch.public_id}</td><td>{batch.order_public_id}</td><td>{batch.customer_name}</td><td>{batch.formula_name || '—'}</td>
      <td>{batch.production_quantity} unit + {batch.wastage_percent}%</td><td>{batch.material_count}</td><td><Status value={batch.status}/></td>
      <td>{batch.status === 'PENDING' && <form action="/api/admin/batches" method="post"><input type="hidden" name="action" value="complete"/><input type="hidden" name="batch_id" value={batch.id}/><input type="hidden" name="expected_status" value={batch.status}/><button className="btn secondary">Complete and consume stock</button></form>}</td>
    </tr>)}</tbody></table></div>
    {batches.rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/batches?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(batches.rows[49]) }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
