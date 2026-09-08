import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function Dispatch({ searchParams }) {
  const staff = await requireStaff({ roles: ['OPERATIONS'] });
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const cursor = parseCursor(params?.cursor);
  const { rows } = await query(`
    SELECT o.id,o.id order_id,o.created_at,o.public_id order_public_id,o.status order_status,o.shipping_address,
           c.name customer_name,d.id dispatch_id,d.public_id dispatch_public_id,
           d.status dispatch_status,d.courier,d.awb
    FROM orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN dispatches d ON d.order_id=o.id
    WHERE (o.status IN ('READY_TO_DISPATCH','SHIPPED','DELIVERED') OR d.id IS NOT NULL)
      AND ($1='' OR o.public_id ILIKE $1||'%' OR lower(c.name) LIKE lower($1)||'%' OR d.awb ILIKE $1||'%')
      AND ($2::timestamptz IS NULL OR (o.created_at,o.id)<($2::timestamptz,$3::uuid))
    ORDER BY o.created_at DESC,o.id DESC LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Prerequisite-controlled fulfilment</div><h1>Dispatch</h1></div></div>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Order, customer, or AWB"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/dispatch">Clear</a>}</form><div style={{height:16}}/>
    <div className="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Address</th><th>Order / dispatch</th><th>Courier / AWB</th><th>Actions</th></tr></thead><tbody>{rows.slice(0,50).map((row) => <tr key={row.order_id}>
      <td>{row.order_public_id}</td><td>{row.customer_name}</td><td>{row.shipping_address || '—'}</td>
      <td><Status value={row.order_status}/><div style={{height:4}}/><Status value={row.dispatch_status || 'NO_DISPATCH'}/></td>
      <td>{row.courier || '—'}<div className="small muted">{row.awb || ''}</div></td>
      <td><div className="stack">
        {row.order_status === 'READY_TO_DISPATCH' && <form action="/api/admin/dispatch" method="post" className="row">
          <input type="hidden" name="action" value="ship"/><input type="hidden" name="order_id" value={row.order_id}/><input type="hidden" name="expected_order_status" value={row.order_status}/><input type="hidden" name="expected_dispatch_status" value={row.dispatch_status || 'NONE'}/>
          <input name="courier" placeholder="Courier" defaultValue={row.courier || ''} required maxLength={120}/><input name="awb" placeholder="AWB" defaultValue={row.awb || ''} required maxLength={120}/><button className="btn secondary">Mark dispatched</button>
        </form>}
        {row.order_status === 'SHIPPED' && row.dispatch_status === 'DISPATCHED' && <form action="/api/admin/dispatch" method="post">
          <input type="hidden" name="action" value="deliver"/><input type="hidden" name="order_id" value={row.order_id}/><input type="hidden" name="expected_order_status" value={row.order_status}/><input type="hidden" name="expected_dispatch_status" value={row.dispatch_status}/><button className="btn">Mark delivered</button>
        </form>}
      </div></td>
    </tr>)}</tbody></table></div>
    {rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/dispatch?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(rows[49]) }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
