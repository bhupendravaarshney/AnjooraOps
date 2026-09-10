import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { roleCan } from '@/lib/rbac';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import RecommendationFulfilmentFields from '@/app/components/RecommendationFulfilmentFields';

export const dynamic = 'force-dynamic';

function RecommendationForm({ consultationId, expectedReviewStatus, formulaIngredients, previous = null, previousFormulaItems = [], title = 'Create recommendation' }) {
  return <div className="stack">
    <h3>{title}</h3>
    <form action="/api/admin/recommendations" method="post" className="stack">
      <input type="hidden" name="consultation_id" value={consultationId}/>
      <input type="hidden" name="expected_review_status" value={expectedReviewStatus}/>
      {previous?.formula_id && <input type="hidden" name="previous_formula_id" value={previous.formula_id}/>}      
      <div className="field">
        <label>Recommendation summary</label>
        <textarea name="summary" required defaultValue={previous?.summary || ''} placeholder="What is recommended and why"/>
      </div>
      <RecommendationFulfilmentFields
        initialType={previous?.fulfillment_type || 'STANDARD'}
        initialProductRef={previous?.product_sku || previous?.product_public_id || ''}
        initialFormulaName={previous?.formula_name || ''}
        initialFormulaFormat={previous?.formula_format || ''}
        ingredients={formulaIngredients}
        initialItems={previousFormulaItems}
      />
      <div className="grid grid-2">
        <div className="field">
          <label>Duration days</label>
          <input type="number" name="duration_days" min="1" max="3650" step="1" required defaultValue={previous?.duration_days || 30}/>
        </div>
      </div>
      <div className="field">
        <label>Usage instructions</label>
        <textarea name="usage_instructions" defaultValue={previous?.usage_instructions || ''}/>
      </div>
      <button className="btn" type="submit">{previous ? 'Approve revised recommendation' : 'Approve recommendation'}</button>
    </form>
  </div>;
}

export default async function ConsultationDetail({ params }) {
  const staff = await requireStaff({ capability: 'CONSULTATIONS_VIEW' });
  const { id } = await params;
  const base = await query(`
    SELECT c.*,cu.name,cu.phone,cu.city,cu.language,cu.best_contact_time,
           rc.id review_case_id,rc.public_id review_case_public_id,rc.status review_status,
           rc.clarification_question
    FROM consultations c
    JOIN customers cu ON cu.id=c.customer_id
    JOIN review_cases rc ON rc.consultation_id=c.id
    WHERE c.id=$1
  `, [id]);
  const c = base.rows[0];
  if (!c) notFound();

  const [notes, recs, concernsResult, safetyResult, formulaIngredientsResult] = await Promise.all([
    query(`SELECT * FROM consultation_notes WHERE consultation_id=$1 ORDER BY created_at DESC`, [id]),
    query(`
      SELECT r.*,p.public_id product_public_id,p.sku product_sku,p.name product_name,f.name formula_name,f.format formula_format,
             f.public_id formula_public_id,f.version formula_version
      FROM recommendations r
      LEFT JOIN products p ON p.id=r.product_id
      LEFT JOIN formulas f ON f.id=r.formula_id
      WHERE r.consultation_id=$1
      ORDER BY r.created_at DESC
    `, [id]),
    query(`
      SELECT concern_key, concern_label, is_primary, position
      FROM consultation_concerns
      WHERE consultation_id=$1
      ORDER BY position
    `, [id]),
    query(`
      SELECT flag_code, flag_label, severity, position
      FROM consultation_safety_flags
      WHERE consultation_id=$1
      ORDER BY position
    `, [id]),
    query(`
      SELECT ingredient.id,ingredient.public_id,ingredient.name,ii.sku,ii.unit
      FROM formula_ingredients ingredient
      JOIN inventory_items ii ON ii.id=ingredient.inventory_item_id
      WHERE ingredient.active=true AND ii.active=true
      ORDER BY lower(ingredient.name),ii.sku,ingredient.id
    `),
  ]);

  const concerns = concernsResult.rows.length
    ? concernsResult.rows
    : [{ concern_key: 'legacy', concern_label: c.concern, is_primary: true, position: 1 }];
  const primaryConcern = concerns.find((item) => item.is_primary) || concerns[0];
  const linkedConcerns = concerns.filter((item) => item !== primaryConcern);
  const safetyFlags = safetyResult.rows;

  const latestRec = recs.rows[0];
  const order = latestRec
    ? (await query(`SELECT * FROM orders WHERE recommendation_id=$1 ORDER BY created_at DESC LIMIT 1`, [latestRec.id])).rows[0]
    : null;
  const formulaItems = latestRec?.formula_id
    ? (await query(`SELECT fi.*,ii.sku FROM formula_items fi LEFT JOIN inventory_items ii ON ii.id=fi.inventory_item_id WHERE fi.formula_id=$1 ORDER BY fi.id`, [latestRec.formula_id])).rows
    : [];
  const formulaIngredients = formulaIngredientsResult.rows;
  const mayRevise = Boolean(latestRec && !c.urgent_safety_flag && c.review_status === 'READY_FOR_RECOMMENDATION');
  const mayReview = roleCan(staff.role, 'CLINICAL_REVIEW');
  const mayOperate = roleCan(staff.role, 'OPERATIONS');

  return <AdminShell staff={staff}>
    <div className="section-head">
      <div>
        <div className="tag">{c.folio_id}</div>
        <h1>{c.name}</h1>
        <div className="row">
          <span className="concern-chip primary">Primary · {primaryConcern.concern_label}</span>
          {linkedConcerns.map((item) => <span className="concern-chip" key={item.concern_key}>{item.concern_label}</span>)}
          <Status value={c.review_status}/>
        </div>
      </div>
    </div>

    <section className={`safety-panel ${c.urgent_safety_flag ? 'urgent' : c.safety_review_required ? 'review' : 'clear'}`}>
      <div>
        <div className="tag">Safety screen</div>
        <h2>
          {c.urgent_safety_flag
            ? 'Urgent stop — do not prepare a wellness recommendation'
            : c.safety_review_required
              ? 'Human safety review required before recommendation'
              : 'No listed safety concern'}
        </h2>
        <p>
          {c.urgent_safety_flag
            ? 'Close or hold this case and direct the customer to appropriate medical assessment.'
            : c.safety_review_required
              ? 'Review every flag below and request clarification where needed before proceeding.'
              : 'The customer selected none of the listed safety concerns.'}
        </p>
      </div>
      <div className="safety-flags">
        {safetyFlags.map((flag) => <span className={`safety-flag ${flag.severity.toLowerCase()}`} key={flag.flag_code}>
          {flag.flag_label}
        </span>)}
        {!safetyFlags.length && <span className="safety-flag review">Safety screen not available</span>}
      </div>
    </section>

    <div className="grid grid-2">
      <section className="card">
        <h2>Consultation folio</h2>
        <div className="folio">{c.folio_text}</div>
      </section>
      <div className="stack">
        <section className="card">
          <h2>Vaidya review</h2>
          {mayReview ? <form action="/api/admin/review" method="post" className="stack">
            <input type="hidden" name="case_id" value={c.review_case_id}/>
            <input type="hidden" name="expected_status" value={c.review_status}/>
            <div className="field">
              <label>Clarification question</label>
              <textarea name="question" defaultValue={c.clarification_question || ''} placeholder="Only if more information is needed"/>
            </div>
            <div className="row">
              <button className="btn" name="action" value="clarification">Request clarification</button>
              {!c.urgent_safety_flag && <button className="btn secondary" name="action" value="recommend">Ready for recommendation</button>}
              <button className="btn secondary" name="action" value="hold">Hold</button>
              <button className="btn danger" name="action" value="close">Close</button>
            </div>
          </form> : <p className="muted">A Vaidya must review and change this case.</p>}
        </section>

        <section className="card">
          <h2>Additional WhatsApp / consultation notes</h2>
          {notes.rows.length ? notes.rows.map((n) => <div key={n.id} style={{padding:'10px 0',borderBottom:'1px solid var(--line)'}}>
            <div className="small muted">{n.note_type} · {new Date(n.created_at).toLocaleString()}</div>
            <div>{n.body}</div>
          </div>) : <p className="muted">No additional information yet.</p>}
        </section>
      </div>
    </div>

    <div style={{height:20}}/>
    <section className="card stack">
      <h2>{latestRec ? 'Recommendation' : 'Create recommendation'}</h2>
      {latestRec ? <>
        <div className="stack">
          <div><Status value={latestRec.status}/></div>
          <strong>{latestRec.summary}</strong>
          <div className="small muted">
            {latestRec.fulfillment_type} · {latestRec.duration_days || '—'} days · {latestRec.product_name || latestRec.formula_name || 'No linked item'}
            {latestRec.formula_public_id ? ` · ${latestRec.formula_public_id}-V${latestRec.formula_version}` : ''}
          </div>
          {latestRec.usage_instructions && <div>{latestRec.usage_instructions}</div>}
          {formulaItems.length > 0 && <div className="table-wrap"><table>
            <thead><tr><th>SKU</th><th>Ingredient</th><th>Qty</th></tr></thead>
            <tbody>{formulaItems.map((i) => <tr key={i.id}><td>{i.sku || 'unmapped'}</td><td>{i.ingredient_name}</td><td>{i.quantity} {i.unit}</td></tr>)}</tbody>
          </table></div>}

          {order
            ? <div className="notice">Order {order.public_id} · {order.status}</div>
            : mayOperate ? <form action="/api/admin/orders" method="post" className="stack">
                <input type="hidden" name="recommendation_id" value={latestRec.id}/>
                <div className="grid grid-2">
                  <div className="field"><label>Subtotal</label><input type="number" min="0.01" step="0.01" name="subtotal" required/></div>
                  <div className="field"><label>Discount</label><input type="number" min="0" step="0.01" name="discount_amount" defaultValue="0"/></div>
                  <div className="field"><label>Tax</label><input type="number" min="0" step="0.01" name="tax_amount" defaultValue="0"/></div>
                  <div className="field"><label>Shipping</label><input type="number" min="0" step="0.01" name="shipping_amount" defaultValue="0"/></div>
                </div>
                <div className="field"><label>Shipping address</label><input name="shipping_address"/></div>
                <button className="btn" type="submit">Create order for customer acceptance</button>
              </form> : <div className="muted">An operations user must create the order.</div>}
        </div>
        {mayRevise && <div style={{borderTop:'1px solid var(--line)',paddingTop:18}}>
          {mayReview && <RecommendationForm consultationId={c.id} expectedReviewStatus={c.review_status} formulaIngredients={formulaIngredients} previous={latestRec} previousFormulaItems={formulaItems} title="Create revised recommendation / next formula version"/>}
        </div>}
      </> : c.urgent_safety_flag
        ? <div className="error">Recommendation creation is blocked because this consultation contains an urgent safety flag.</div>
        : mayReview && c.review_status === 'READY_FOR_RECOMMENDATION'
          ? <RecommendationForm consultationId={c.id} expectedReviewStatus={c.review_status} formulaIngredients={formulaIngredients}/>
          : <div className="muted">A Vaidya must complete review and mark this case ready before creating a recommendation.</div>}      
    </section>
  </AdminShell>;
}
