import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { tokenHash } from '@/lib/security';

export const dynamic = 'force-dynamic';

export default async function AcceptOrderPage({ params, searchParams }) {
  const { token } = await params;
  const queryParams = await searchParams;
  if (!token || token.length > 100) notFound();
  const order = (await query(`
    SELECT o.id,o.public_id,o.status,o.subtotal,o.discount_amount,o.tax_amount,o.shipping_amount,
           o.amount,o.currency,o.accepted_at,pi.payment_url,pi.status payment_intent_status,
           oi.description,cu.name customer_name
    FROM orders o
    JOIN customers cu ON cu.id=o.customer_id
    JOIN order_items oi ON oi.order_id=o.id
    LEFT JOIN LATERAL (
      SELECT status,payment_url FROM payment_intents WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1
    ) pi ON true
    WHERE o.acceptance_nonce=$1
    LIMIT 1
  `, [tokenHash(token)])).rows[0];
  if (!order) notFound();
  const accepted = Boolean(order.accepted_at);
  return <main className="container" style={{maxWidth:720,paddingTop:48}}>
    <section className="card stack">
      <div className="tag">Secure order review</div>
      <h1>{order.public_id}</h1>
      <p>Hello {order.customer_name}. Please review the commercial details before accepting.</p>
      <div className="table-wrap"><table><tbody>
        <tr><th>Recommendation</th><td>{order.description}</td></tr>
        <tr><th>Subtotal</th><td>₹{order.subtotal}</td></tr>
        <tr><th>Discount</th><td>− ₹{order.discount_amount}</td></tr>
        <tr><th>Tax</th><td>₹{order.tax_amount}</td></tr>
        <tr><th>Shipping</th><td>₹{order.shipping_amount}</td></tr>
        <tr><th>Total</th><td><strong>₹{order.amount} {order.currency}</strong></td></tr>
      </tbody></table></div>
      {accepted ? <>
        <div className="notice">Order accepted. Payment status: {String(order.payment_intent_status || order.status).replaceAll('_', ' ')}.</div>
        {order.payment_url
          ? <a className="btn" href={order.payment_url} rel="noreferrer">Continue to secure payment</a>
          : <p className="muted">The ANJOORA team will send the configured secure payment link. Production will not start until payment is confirmed.</p>}
      </> : <form action="/api/orders/accept" method="post" className="stack">
        <input type="hidden" name="token" value={token}/>
        <label className="row" style={{alignItems:'flex-start'}}>
          <input type="checkbox" name="accepted" value="yes" required style={{width:'auto',marginTop:4}}/>
          <span>I accept this recommendation and the itemized order total. I understand that payment is a separate step.</span>
        </label>
        <button className="btn" type="submit">Accept order</button>
      </form>}
      {queryParams?.accepted && <div className="small muted">Acceptance was recorded using server time and request evidence.</div>}
    </section>
  </main>;
}
