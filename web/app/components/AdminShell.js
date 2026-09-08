const links = [
  ['/admin', 'Dashboard', ['ADMIN', 'VAIDYA', 'OPERATIONS', 'SUPPORT']],
  ['/admin/consultations', 'Consultations', ['ADMIN', 'VAIDYA', 'OPERATIONS']],
  ['/admin/orders', 'Orders', ['ADMIN', 'OPERATIONS']],
  ['/admin/inventory', 'Inventory', ['ADMIN', 'OPERATIONS']],
  ['/admin/batches', 'Batches', ['ADMIN', 'OPERATIONS']],
  ['/admin/dispatch', 'Dispatch', ['ADMIN', 'OPERATIONS']],
  ['/admin/refills', 'Refills', ['ADMIN', 'OPERATIONS']],
  ['/admin/whatsapp', 'WhatsApp', ['ADMIN', 'VAIDYA', 'SUPPORT']],
  ['/admin/privacy', 'Privacy', ['ADMIN']],
];

export default function AdminShell({ staff, children }) {
  return <>
    <header className="topbar">
      <div><div className="brand">ANJOORA</div><div className="tag">Operations Console</div></div>
      <nav className="nav">{links.filter(([, , roles]) => roles.includes(staff?.role)).map(([href, label]) => <a href={href} key={href}>{label}</a>)}</nav>
      <div className="row"><a className="small" href="/admin/account/sessions">{staff?.name} · {staff?.role}</a><a className="small" href="/admin/account/mfa">MFA</a><form action="/api/auth/logout" method="post"><button className="btn secondary" type="submit">Logout</button></form></div>
    </header>
    <main className="container">{children}</main>
  </>;
}
