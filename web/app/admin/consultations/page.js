import { requireStaff } from '@/lib/auth';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { encodeCursor, parseCursor, searchTerm } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

function SafetyStatus({ reviewRequired, urgent }) {
  if (urgent) return <span className="status danger">URGENT STOP</span>;
  if (reviewRequired) return <span className="status warn">REVIEW REQUIRED</span>;
  return <span className="status ok">CLEAR</span>;
}

export default async function Consultations({ searchParams }) {
  const staff = await requireStaff({ roles: ['VAIDYA', 'OPERATIONS'] });
  const requested = await searchParams;
  const concernFilter = typeof requested?.concern === 'string' ? requested.concern : '';
  const requestedSafety = typeof requested?.safety === 'string' ? requested.safety : '';
  const safetyFilter = ['clear', 'review', 'urgent'].includes(requestedSafety) ? requestedSafety : '';
  const search = searchTerm(requested?.q);
  const cursor = parseCursor(requested?.cursor);

  const [consultations, concernOptions] = await Promise.all([
    query(`
      SELECT
        c.id,
        c.folio_id,
        c.concern,
        c.main_goal,
        c.preferred_format,
        c.safety_review_required,
        c.urgent_safety_flag,
        c.created_at,
        cu.name,
        cu.phone,
        rc.status,
        COALESCE(
          (SELECT string_agg(cc.concern_label, ', ' ORDER BY cc.position)
           FROM consultation_concerns cc
           WHERE cc.consultation_id=c.id),
          c.concern
        ) AS concern_list
      FROM consultations c
      JOIN customers cu ON cu.id=c.customer_id
      JOIN review_cases rc ON rc.consultation_id=c.id
      WHERE (
        $1 = '' OR EXISTS (
          SELECT 1 FROM consultation_concerns cc
          WHERE cc.consultation_id=c.id AND cc.concern_key=$1
        )
      )
      AND (
        $2 = ''
        OR ($2 = 'clear' AND c.safety_review_required=false)
        OR ($2 = 'review' AND c.safety_review_required=true AND c.urgent_safety_flag=false)
        OR ($2 = 'urgent' AND c.urgent_safety_flag=true)
      )
      AND ($3='' OR lower(cu.name) LIKE lower($3)||'%' OR cu.phone LIKE $3||'%' OR c.folio_id ILIKE $3||'%')
      AND ($4::timestamptz IS NULL OR (c.created_at,c.id)<($4::timestamptz,$5::uuid))
      ORDER BY c.created_at DESC,c.id DESC
      LIMIT 51
    `, [concernFilter, safetyFilter, search, cursor?.timestamp || null, cursor?.id || null]),
    query(`
      SELECT concern_key, concern_label
      FROM consultation_concerns
      GROUP BY concern_key, concern_label
      ORDER BY concern_label
    `),
  ]);

  return <AdminShell staff={staff}>
    <div className="section-head">
      <div>
        <div className="tag">Vaidya queue</div>
        <h1>Consultations</h1>
      </div>
    </div>

    <form method="get" className="card filter-bar">
      <div className="field"><label htmlFor="consultation-search">Search</label><input id="consultation-search" name="q" defaultValue={search} placeholder="Name, phone, or folio"/></div>
      <div className="field">
        <label htmlFor="concern-filter">Concern</label>
        <select id="concern-filter" name="concern" defaultValue={concernFilter}>
          <option value="">All concerns</option>
          {concernOptions.rows.map((item) => (
            <option key={`${item.concern_key}-${item.concern_label}`} value={item.concern_key}>
              {item.concern_label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="safety-filter">Safety</label>
        <select id="safety-filter" name="safety" defaultValue={safetyFilter}>
          <option value="">All safety outcomes</option>
          <option value="clear">Clear</option>
          <option value="review">Review required</option>
          <option value="urgent">Urgent stop</option>
        </select>
      </div>
      <button className="btn" type="submit">Apply filters</button>
      {(concernFilter || safetyFilter || search) && <a className="btn secondary" href="/admin/consultations">Clear</a>}
    </form>

    <div style={{ height: 18 }}/>
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Folio</th>
            <th>Customer</th>
            <th>Concerns</th>
            <th>Goal</th>
            <th>Safety</th>
            <th>Format</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {consultations.rows.slice(0, 50).map((item) => <tr key={item.id}>
            <td>{item.folio_id}</td>
            <td>{item.name}<div className="small muted">{item.phone}</div></td>
            <td>
              <strong>{item.concern}</strong>
              {item.concern_list !== item.concern && <div className="small muted">All: {item.concern_list}</div>}
            </td>
            <td>{item.main_goal || '—'}</td>
            <td><SafetyStatus reviewRequired={item.safety_review_required} urgent={item.urgent_safety_flag}/></td>
            <td>{item.preferred_format || '—'}</td>
            <td><Status value={item.status}/></td>
            <td><a className="btn secondary" href={`/admin/consultations/${item.id}`}>Review</a></td>
          </tr>)}
          {!consultations.rows.length && <tr><td colSpan="8" className="muted">No consultations match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
    {consultations.rows.length > 50 && <div style={{marginTop:16}}><a className="btn secondary" href={`/admin/consultations?${new URLSearchParams({ ...(search ? {q:search} : {}), ...(concernFilter ? {concern:concernFilter} : {}), ...(safetyFilter ? {safety:safetyFilter} : {}), cursor:encodeCursor(consultations.rows[49]) }).toString()}`}>Next page</a></div>}
  </AdminShell>;
}
