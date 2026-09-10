import { requireStaff } from '@/lib/auth';
import { roleCan } from '@/lib/rbac';
import { query } from '@/lib/db';
import AdminShell from '@/app/components/AdminShell';
import Status from '@/app/components/Status';
import { refillReminderDays } from '@/lib/refills';

export const dynamic = 'force-dynamic';

function SafetyStatus({ reviewRequired, urgent }) {
  if (urgent) return <span className="status danger">URGENT STOP</span>;
  if (reviewRequired) return <span className="status warn">REVIEW REQUIRED</span>;
  return <span className="status ok">CLEAR</span>;
}

export default async function Dashboard() {
  const staff = await requireStaff();
  const mayReview = roleCan(staff.role, 'CLINICAL_REVIEW');
  const mayOperate = roleCan(staff.role, 'OPERATIONS');
  const maySupport = roleCan(staff.role, 'WHATSAPP');
  const reminderDays = refillReminderDays();
  const [newCases, orders, batches, refills, handoffs, latest] = await Promise.all([
    mayReview ? query(`SELECT count(*)::int n FROM review_cases WHERE status IN ('NEW','CLARIFICATION_REQUIRED','READY_FOR_RECOMMENDATION')`) : null,
    mayOperate ? query(`SELECT count(*)::int n FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED','REFUNDED')`) : null,
    mayOperate ? query(`SELECT count(*)::int n FROM batches WHERE status='PENDING'`) : null,
    mayOperate ? query(`SELECT count(*)::int n FROM refills WHERE status NOT IN ('CLOSED','ORDERED') AND due_date<=current_date+($1 * interval '1 day')`, [reminderDays]) : null,
    maySupport ? query(`SELECT count(*)::int n FROM whatsapp_conversations WHERE needs_human=true`) : null,
    mayReview ? query(`
      SELECT c.id,c.folio_id,c.concern,c.main_goal,c.safety_review_required,c.urgent_safety_flag,
             c.created_at,cu.name,rc.status,
             COALESCE((SELECT string_agg(cc.concern_label,', ' ORDER BY cc.position) FROM consultation_concerns cc WHERE cc.consultation_id=c.id),c.concern) concern_list
      FROM consultations c JOIN customers cu ON cu.id=c.customer_id
      JOIN review_cases rc ON rc.consultation_id=c.id
      ORDER BY c.created_at DESC,c.id DESC LIMIT 8
    `) : null,
  ]);
  return <AdminShell staff={staff}>
    <div className="section-head"><div><div className="tag">Role-specific operating view</div><h1>Dashboard</h1><p className="muted">Only queues permitted for {staff.role.toLowerCase()} access are shown.</p></div></div>
    <div className="grid grid-4">
      {mayReview && <div className="card"><div className="muted small">Review attention</div><div className="metric">{newCases.rows[0].n}</div></div>}
      {mayOperate && <><div className="card"><div className="muted small">Active orders</div><div className="metric">{orders.rows[0].n}</div></div><div className="card"><div className="muted small">Open batches</div><div className="metric">{batches.rows[0].n}</div></div><div className="card"><div className="muted small">Refill due ≤ {reminderDays} days</div><div className="metric">{refills.rows[0].n}</div></div></>}
      {maySupport && <div className="card"><div className="muted small">Human WhatsApp handoffs</div><div className="metric">{handoffs.rows[0].n}</div></div>}
    </div>
    {mayReview && <><div style={{height:24}}/><h2>Latest consultations</h2><div className="table-wrap"><table><thead><tr><th>Folio</th><th>Customer</th><th>Concerns</th><th>Goal</th><th>Safety</th><th>Status</th><th></th></tr></thead><tbody>{latest.rows.map((item) => <tr key={item.id}><td>{item.folio_id}</td><td>{item.name}</td><td><strong>{item.concern}</strong>{item.concern_list !== item.concern && <div className="small muted">All: {item.concern_list}</div>}</td><td>{item.main_goal || '—'}</td><td><SafetyStatus reviewRequired={item.safety_review_required} urgent={item.urgent_safety_flag}/></td><td><Status value={item.status}/></td><td><a className="btn secondary" href={`/admin/consultations/${item.id}`}>Open</a></td></tr>)}</tbody></table></div></>}
  </AdminShell>;
}
