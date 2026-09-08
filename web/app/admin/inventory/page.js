import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function Inventory({ searchParams }) {
  const staff = await requireStaff({ roles: ['OPERATIONS'] });
  const params = await searchParams;
  const search = searchTerm(params?.q);
  const stockCursor = parseCursor(params?.stock_cursor);
  const productCursor = parseCursor(params?.product_cursor);
  const [stock, products] = await Promise.all([
    query(`
      SELECT s.*,i.created_at
      FROM inventory_stock s JOIN inventory_items i ON i.id=s.id
      WHERE ($1='' OR s.sku ILIKE $1||'%' OR lower(s.name) LIKE lower($1)||'%')
        AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2::timestamptz,$3::uuid))
      ORDER BY i.created_at DESC,i.id DESC LIMIT 51
    `, [search, stockCursor?.timestamp || null, stockCursor?.id || null]),
    query(`
      SELECT p.id,p.public_id,p.sku,p.name,p.created_at,p.inventory_item_id,p.inventory_quantity,ii.sku inventory_sku,ii.unit inventory_unit
      FROM products p LEFT JOIN inventory_items ii ON ii.id=p.inventory_item_id
      WHERE p.active=true
        AND ($1='' OR p.sku ILIKE $1||'%' OR lower(p.name) LIKE lower($1)||'%' OR ii.sku ILIKE $1||'%')
        AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2::timestamptz,$3::uuid))
      ORDER BY p.created_at DESC,p.id DESC LIMIT 51
    `, [search, productCursor?.timestamp || null, productCursor?.id || null]),
  ]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Immutable stock ledger</div><h1>Inventory</h1></div></div>
    <form className="card row" method="get"><input name="q" defaultValue={search} placeholder="Inventory or product SKU/name"/><button className="btn">Search</button>{search && <a className="btn secondary" href="/admin/inventory">Clear</a>}</form><div style={{height:16}}/>
    <div className="grid grid-2">
      <section className="card"><h2>Add or safely update item</h2><form action="/api/admin/inventory" method="post" className="stack">
        <input type="hidden" name="action" value="create_item"/>
        <div className="grid grid-2">
          <div className="field"><label>SKU</label><input name="sku" required maxLength={64}/></div>
          <div className="field"><label>Name</label><input name="name" required maxLength={120}/></div>
          <div className="field"><label>Canonical unit</label><select name="unit" defaultValue="g"><option>g</option><option>kg</option><option>ml</option><option>l</option><option>unit</option></select></div>
          <div className="field"><label>Reorder level</label><input name="reorder_level" type="number" min="0" step="0.001" defaultValue="0"/></div>
        </div><button className="btn">Save item</button>
      </form></section>
      <section className="card"><h2>Receive or adjust stock</h2><form action="/api/admin/inventory" method="post" className="stack">
        <div className="field"><label>Item SKU or public ID</label><input name="item_ref" required maxLength={100} placeholder="RM-ASHWAGANDHA"/></div>
        <div className="grid grid-2">
          <div className="field"><label>Action</label><select name="action"><option value="receipt">Receipt (+)</option><option value="adjustment">Adjustment (+/−)</option></select></div>
          <div className="field"><label>Quantity</label><input name="quantity" type="number" step="0.001" required/></div>
          <div className="field"><label>Reference</label><input name="reference" maxLength={120}/></div>
          <div className="field"><label>Note</label><input name="note" maxLength={500}/></div>
        </div><button className="btn">Post immutable transaction</button>
      </form></section>
    </div>
    <div style={{height:20}}/>
    <section className="card"><h2>Finished-goods mapping</h2><p className="muted">Map each standard product to the stock item and quantity consumed by one order unit.</p>
      <form action="/api/admin/inventory" method="post" className="row">
        <input type="hidden" name="action" value="map_product"/>
        <input name="product_ref" required maxLength={100} placeholder="Product SKU or public ID"/>
        <input name="item_ref" required maxLength={100} placeholder="Inventory SKU or public ID"/>
        <input name="quantity" type="number" min="0.001" step="0.001" placeholder="Qty per unit" required/>
        <button className="btn secondary">Save mapping</button>
      </form>
      <div className="table-wrap" style={{marginTop:16}}><table><thead><tr><th>Product</th><th>Stock mapping</th></tr></thead><tbody>{products.rows.slice(0,50).map((product) => <tr key={product.id}><td>{product.sku} · {product.name}</td><td>{product.inventory_sku ? `${product.inventory_quantity} ${product.inventory_unit} of ${product.inventory_sku}` : 'Not mapped'}</td></tr>)}</tbody></table></div>
      {products.rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/inventory?${new URLSearchParams({ ...(search ? {q:search} : {}), product_cursor:encodeCursor(products.rows[49]) }).toString()}`}>Next product page</a></div>}
    </section>
    <div style={{height:20}}/>
    <div className="table-wrap"><table><thead><tr><th>SKU</th><th>Item</th><th>Available</th><th>Unit</th><th>Reorder level</th></tr></thead><tbody>{stock.rows.slice(0,50).map((item) => <tr key={item.id}><td>{item.sku}</td><td>{item.name}</td><td><strong>{item.available_quantity}</strong></td><td>{item.unit}</td><td>{item.reorder_level}</td></tr>)}</tbody></table></div>
    {stock.rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/inventory?${new URLSearchParams({ ...(search ? {q:search} : {}), stock_cursor:encodeCursor(stock.rows[49]) }).toString()}`}>Next inventory page</a></div>}
  </AdminShell>;
}
