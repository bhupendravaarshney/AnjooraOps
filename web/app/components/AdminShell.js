import { roleCan } from '@/lib/rbac';

const links = [
  ['/admin', 'Dashboard', 'DASHBOARD'],
  ['/admin/consultations', 'Consultations', 'CONSULTATIONS_VIEW'],
  ['/admin/orders', 'Orders', 'OPERATIONS'],
  ['/admin/inventory', 'Inventory', 'OPERATIONS'],
  ['/admin/batches', 'Batches', 'OPERATIONS'],
  ['/admin/dispatch', 'Dispatch', 'OPERATIONS'],
  ['/admin/refills', 'Refills', 'OPERATIONS'],
  ['/admin/whatsapp', 'WhatsApp', 'WHATSAPP'],
  ['/admin/privacy', 'Privacy', 'PRIVACY'],
  ['/admin/staff', 'Staff', 'STAFF_MANAGEMENT'],
];

export default function AdminShell({ staff, children }) {
  return <>
    <header className="topbar">
      <div><div className="brand">ANJOORA</div><div className="tag">Operations Console</div></div>
      <nav className="nav">{links.filter(([, , capability]) => roleCan(staff?.role, capability)).map(([href, label]) => <a href={href} key={href}>{label}</a>)}</nav>
      <div className="row"><a className="small" href="/admin/account/sessions">{staff?.name} · {staff?.role}</a><form action="/api/auth/logout" method="post"><button className="btn secondary" type="submit">Logout</button></form></div>
    </header>
    <main className="container">{children}</main>
  </>;
}
