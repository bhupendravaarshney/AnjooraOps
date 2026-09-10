import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import { uuid } from '@/lib/ids';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function WhatsApp({ searchParams }) {
  const staff = await requireStaff({ capability: 'WHATSAPP' });
  const sp = await searchParams;
  const search = searchTerm(sp?.q);
  const cursor = parseCursor(sp?.cursor);
  const messageCursor = parseCursor(sp?.message_cursor);
  const conversations = await query(`
    SELECT wc.*,COALESCE(wc.last_message_at,wc.created_at) cursor_at,c.name,c.phone,co.folio_id,o.public_id order_public_id
    FROM whatsapp_conversations wc JOIN customers c ON c.id=wc.customer_id
    LEFT JOIN consultations co ON co.id=wc.active_consultation_id
    LEFT JOIN orders o ON o.id=wc.active_order_id
    WHERE ($1='' OR lower(c.name) LIKE lower($1)||'%' OR c.phone LIKE $1||'%')
      AND ($2::timestamptz IS NULL OR (COALESCE(wc.last_message_at,wc.created_at),wc.id)<($2::timestamptz,$3::uuid))
    ORDER BY COALESCE(wc.last_message_at,wc.created_at) DESC,wc.id DESC LIMIT 51
  `, [search, cursor?.timestamp || null, cursor?.id || null]);
  const selectedId = sp?.conversation || conversations.rows[0]?.id;
  const selected = selectedId
    ? conversations.rows.find((item) => item.id === selectedId) || (await query(`
        SELECT wc.*,c.name,c.phone,co.folio_id,o.public_id order_public_id
        FROM whatsapp_conversations wc JOIN customers c ON c.id=wc.customer_id
        LEFT JOIN consultations co ON co.id=wc.active_consultation_id
        LEFT JOIN orders o ON o.id=wc.active_order_id WHERE wc.id=$1
      `, [selectedId])).rows[0]
    : null;
  const messageRows = selected ? (await query(`
    SELECT * FROM whatsapp_messages
    WHERE conversation_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
    ORDER BY created_at DESC,id DESC LIMIT 51
  `, [selected.id, messageCursor?.timestamp || null, messageCursor?.id || null])).rows : [];
  const messages = messageRows.slice(0,50).reverse();
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Conversation layer</div><h1>WhatsApp</h1><p className="muted">Bot status, delivery tracking, clarification capture, and human handoff.</p></div></div>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Customer or phone"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/whatsapp">Clear</a>}</form><div style={{height:16}}/>
    <div className="grid grid-2">
      <section className="card" style={{padding:0}}><div className="table-wrap" style={{border:0}}><table>
        <thead><tr><th>Customer</th><th>Context</th><th>Status</th></tr></thead>
        <tbody>{conversations.rows.slice(0,50).map((conversation) => <tr key={conversation.id}>
          <td><a href={`/admin/whatsapp?conversation=${conversation.id}`}><strong>{conversation.name}</strong><div className="small muted">{conversation.phone}</div></a></td>
          <td>{conversation.folio_id || conversation.order_public_id || 'No active record'}</td>
          <td><Status value={conversation.needs_human ? 'HUMAN_SUPPORT' : conversation.status}/></td>
        </tr>)}</tbody>
      </table></div></section>
      <section className="card">{selected ? <>
        <div className="section-head"><div><h2>{selected.name}</h2><div className="small muted">{selected.phone} · {selected.folio_id || 'No folio'} · {selected.order_public_id || 'No active order'}</div></div><Status value={selected.needs_human ? 'HUMAN_SUPPORT' : selected.status}/></div>
        <div className="chat">{messages.map((message) => <div key={message.id} className={`bubble ${message.direction === 'OUTBOUND' ? 'out' : ''}`}>
          <div>{message.body || `[${message.message_type}]`}</div>
          <div className="small muted">{message.direction} · {message.intent || '—'} · {message.delivery_status || message.processing_status || '—'} · {new Date(message.created_at).toLocaleString()}</div>
          {message.last_error && <div className="small error">{message.last_error}</div>}
        </div>)}</div>
        {messageRows.length > 50 && <div style={{marginTop:12}}><a className="btn secondary" href={`/admin/whatsapp?${new URLSearchParams({ conversation:selected.id, ...(search ? {q:search} : {}), message_cursor:encodeCursor(messageRows[49]) }).toString()}`}>Older messages</a></div>}
        <form action="/api/admin/whatsapp/send" method="post" className="stack" style={{marginTop:12}}>
          <input type="hidden" name="conversation_id" value={selected.id}/>
          <input type="hidden" name="message_key" value={uuid()}/>
          <div className="field"><label>Human reply</label><textarea name="body" required maxLength={4096}/></div>
          <button className="btn">Queue through WhatsApp</button>
        </form>
      </> : <p className="muted">No conversations yet.</p>}</section>
    </div>
    {conversations.rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/whatsapp?${new URLSearchParams({ ...(search ? {q:search} : {}), cursor:encodeCursor(conversations.rows[49], 'cursor_at') }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
