export default function Home() {
  return <main>
    <section className="hero">
      <div className="hero-inner">
        <div className="tag">ANJOORA · OPERATIONS CORE</div>
        <h1>Consultation to preparation, dispatch and refill — on one customer record.</h1>
        <p>This deployable starter stores the consultation before WhatsApp handoff, gives the Vaidya a review queue, connects recommendations to products or personalised formulas, and tracks orders, batches, inventory, dispatch and refill.</p>
        <div className="row" style={{marginTop:24}}>
          <a className="btn" href="/consult">Test consultation submission</a>
          <a className="btn secondary" href="/admin">Open operations console</a>
        </div>
      </div>
    </section>
  </main>;
}
