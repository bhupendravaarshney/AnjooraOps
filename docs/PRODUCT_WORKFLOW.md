# ANJOORA v1 Product Workflow

## Local build and runtime

The application has been built and verified locally with Next.js 16.3.4, Node.js 24, Docker Desktop, and PostgreSQL 17. The project requires Node.js 20.19 or newer.

### Build

Run these commands from the `AnjooraOps` directory:

```powershell
npm ci
npm run build
npm run verify
```

The verified build completed with the following results:

- dependency installation completed with no reported vulnerabilities
- the Next.js production build compiled successfully
- TypeScript validation passed
- all application routes compiled and 29 page-data targets were generated
- 58 focused unit tests passed
- clean-database migration, constraint, immutable-ledger, and concurrent-stock integration checks passed

### Local environment

The local `.env` file is excluded from Git and configures:

- application URL: `http://localhost:3000`
- PostgreSQL database: `anjoora`
- PostgreSQL user: `anjoora`
- PostgreSQL port: `5432`
- production-mode Next.js runtime
- a local bootstrap administrator
- placeholder WhatsApp settings for development only

Do not reuse the local credentials, placeholder WhatsApp number, or development secrets in production.

### Start with Docker

Docker Desktop must be running. Start the application and database in detached mode:

```powershell
docker compose up --build -d
```

On the first launch, Docker Compose:

1. downloads the Node.js and PostgreSQL images
2. builds the Next.js application image
3. creates the PostgreSQL data volume
4. waits for PostgreSQL to become healthy
5. applies ordered database migrations `001` through `010` under an advisory lock
6. creates the bootstrap administrator
7. starts the application on port `3000`

The database volume is persistent, so later restarts retain application data.

### Application URLs

- Home: [http://localhost:3000](http://localhost:3000)
- Consultation form: [http://localhost:3000/consult](http://localhost:3000/consult)
- Admin console: [http://localhost:3000/admin](http://localhost:3000/admin)
- Admin login: [http://localhost:3000/admin/login](http://localhost:3000/admin/login)
- Health check: [http://localhost:3000/api/health](http://localhost:3000/api/health)

### Local administrator

No administrator password is stored in documentation. Set a unique bootstrap email and password in the local, untracked `.env` file. New bootstrap accounts must rotate that password on first sign-in. Use `npm run staff:manage --workspace=web` with environment variables for explicit account creation, reset, or deactivation.

### Verified runtime checks

The following checks returned HTTP `200`:

- `/`
- `/consult`
- `/admin/login`
- `/api/health`
- authenticated `/admin`

The health endpoint confirms the application can query PostgreSQL without returning database details publicly:

```json
{
  "ok": true,
  "service": "anjoora-ops"
}
```

### Runtime management

Check container status:

```powershell
docker compose ps
```

Follow application logs:

```powershell
docker compose logs -f app
```

Stop the application while preserving its database volume:

```powershell
docker compose down
```

Restart existing containers:

```powershell
docker compose up -d
```

Rebuild after a source change:

```powershell
docker compose up --build -d
```

### Startup implementation note

The workspace-aware launcher in [`web/scripts/start.mjs`](../web/scripts/start.mjs) resolves the Next.js executable through Node.js package resolution. This supports npm's workspace dependency hoisting both on Windows and inside the Docker image.

## Authoritative v1 flow

```text
Customer questionnaire
  -> Choose 1-4 concerns + one primary concern
  -> Complete safety screen
  -> Save customer + consultation + ordered concerns + safety flags + folio
  -> Open WhatsApp
  -> Vaidya review
      -> clarification through WhatsApp if required
      -> recommendation
  -> standard product OR personalised formula
  -> itemized order quote
  -> customer acceptance evidence
  -> verified payment
  -> batch when personalised preparation is needed
     OR finished-goods allocation for a standard product
  -> inventory consumption
  -> packing-ready
  -> dispatch
  -> delivered
  -> refill due
      -> same
      -> modify / Vaidya review
      -> stop
```

## WhatsApp role

WhatsApp is the conversation interface, not the system of record.

```text
Incoming WhatsApp number
  -> customer
  -> active consultation
  -> active order/refill
  -> bot intent
  -> automated status OR human/Vaidya handoff
```

## Objects

1. Customer
2. Consultation + Ordered Concerns + Safety Flags + Folio
3. Review Case
4. WhatsApp Conversation + Messages
5. Recommendation
6. Product
7. Formula + Formula Ingredient Catalogue + Formula Items
8. Order + Order Items
9. Inventory Item + Transactions
10. Batch + Batch Items
11. Dispatch
12. Refill
13. Payment Intent + Payment Events
14. Message Outbox
15. Audit Event
16. Verified Data Subject Request

## Status ownership

- Consultation: submitted/reviewed
- Review: new, clarification pending, clarification required, ready for recommendation, approved, on hold, closed
- Order: awaiting acceptance, awaiting payment, payment pending/review, paid, in production, ready to dispatch, shipped, delivered, cancelled, refunded
- Payment: not started, pending, paid, failed, cancelled, refunded, review required
- Batch: pending, ready for packing
- Dispatch: ready for dispatch, dispatched, delivered
- Refill: not due, due soon, due, review pending, ordered, closed

## Data rule

The user-submitted consultation remains immutable as historical source data. Additional WhatsApp information is written as consultation notes rather than silently replacing the original submission.

The legacy `consultations.concern` field mirrors the primary concern for compatibility. `consultation_concerns` is authoritative for the complete ordered selection, and `consultation_safety_flags` plus the consultation safety indicators are authoritative for the practitioner safety view. Missing legacy safety screens are marked for review rather than treated as clear.

## Practitioner rule

The system may organize data and status, but a human Vaidya owns recommendation/formulation decisions.

## Operational integrity rules

- The browser never receives the Ops integration secret; the ANJOORA server proxy authenticates consultation intake.
- A stable submission UUID makes customer retries return the original response without a duplicate consultation.
- Every workflow mutation checks the expected current state while holding a row lock.
- A current approved recommendation creates at most one initial order; each refill creates at most one next order.
- Customer acceptance and payment are distinct. Production or stock allocation requires `PAID`.
- A database trigger also blocks fulfilment states unless `payment_status=PAID`; provider-event mismatches become auditable review work and delayed failures cannot downgrade paid fulfilment.
- Personalised recommendation ingredients are selected from the active database catalogue; the server supplies their inventory identity, SKU, name, and canonical unit.
- Personalised batch quantity comes from the order and applies explicit wastage. All ingredients must map to matching canonical inventory units.
- Inventory balances are protected against concurrent negative consumption, and ledger entries cannot be edited or deleted.
- Inbound Meta IDs and outbound event keys are unique. Messages use a durable, retryable outbox.
- Material staff actions and rejected transitions produce correlation-aware audit events with minimized payloads.
- The final customer consent is server-owned and versioned; the customer site loads it before submission and stale versions are rejected.

## Operations and data lifecycle

Cursor navigation and indexed search cover the operational queues. The protected maintenance job removes expired sessions, old rate-limit events, configured raw payloads/message bodies, and terminal outbox records while respecting customer legal holds. Verified administrator workflows support access export, correction, and anonymization.

Run the outbox job every minute and the refill/maintenance jobs daily. Configure provider-owned alerts/backups and complete isolated restore drills as described in [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md).
