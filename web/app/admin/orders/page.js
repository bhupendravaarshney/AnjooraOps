import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function Orders({ searchParams }) {
  const staff = await requireStaff({ roles: ['OPERATIONS'] });
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const cursor = parseCursor(params?.cursor);
  const { rows } = await query(`
    SELECT o.*,c.name customer_name,r.fulfillment_type,
           pi.public_id payment_reference,pi.status payment_intent_status
    FROM orders o JOIN customers c ON c.id=o.customer_id
    JOIN recommendations r ON r.id=o.recommendation_id
    LEFT JOIN LATERAL (
      SELECT public_id,status FROM payment_intents WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1
    ) pi ON true
    WHERE ($1='' OR o.public_id ILIKE $1||'%' OR lower(c.name) LIKE lower($1)||'%')
      AND ($2::timestamptz IS NULL OR (o.created_at,o.id)<($2::timestamptz,$3::uuid))
    ORDER BY o.created_at DESC,o.id DESC LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Acceptance and payment gated</div><h1>Orders</h1></div></div>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Order or customer"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/orders">Clear</a>}</form><div style={{height:16}}/>
    <div className="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Type</th><th>Total</th><th>Payment</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>{rows.slice(0,50).map((order) => <tr key={order.id}>
      <td>{order.public_id}</td><td>{order.customer_name}</td><td>{order.fulfillment_type}</td><td>₹{order.amount} {order.currency}</td>
      <td><Status value={order.payment_status}/>{order.payment_reference && <div className="small muted">{order.payment_reference}</div>}</td>
      <td><Status value={order.status}/></td><td>{new Date(order.created_at).toLocaleDateString()}</td>
      <td><div className="stack">
        {staff.role === 'ADMIN' && ['AWAITING_PAYMENT','PAYMENT_PENDING','PAYMENT_REVIEW_REQUIRED'].includes(order.status) && <form action="/api/admin/orders" method="post" className="row"><input type="hidden" name="action" value="mark_paid"/><input type="hidden" name="order_id" value={order.id}/><input type="hidden" name="expected_status" value={order.status}/><input name="payment_reference" placeholder="Verified payment reference" required maxLength={200}/><button className="btn secondary">Reconcile paid</button></form>}
        {order.status === 'PAID' && order.fulfillment_type === 'STANDARD' && <form action="/api/admin/orders" method="post"><input type="hidden" name="action" value="ready"/><input type="hidden" name="order_id" value={order.id}/><input type="hidden" name="expected_status" value={order.status}/><button className="btn secondary">Allocate stock → dispatch</button></form>}
        {order.status === 'PAID' && order.fulfillment_type === 'PERSONALISED' && <a className="btn outline" href={`/admin/batches?order=${encodeURIComponent(order.public_id)}`}>Prepare batch</a>}
      </div></td>
    </tr>)}</tbody></table></div>
    {rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/orders?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(rows[49]) }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
