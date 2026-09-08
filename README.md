# ANJOORA Operations Core v1.0

Deployable Next.js + PostgreSQL starter for the ANJOORA consultation-to-refill workflow.

For step-by-step customer and staff instructions, see the [English and Hindi user handbook](docs/USER_HANDBOOK.md).

## What it includes

- Consultation submission API: backend save happens before WhatsApp redirect.
- Customer identity keyed by normalized WhatsApp number.
- Human-readable Consultation Folio stored with structured questionnaire data.
- Vaidya review queue with clarification, hold, close and recommendation actions.
- Two-way WhatsApp conversation storage and bot routing through Meta WhatsApp Cloud API.
- Human handoff for personal recommendation/formulation questions.
- Standard product and personalised formula records with version-ready schema.
- Itemized order quote, customer acceptance evidence, payment intent, signed payment webhook, and manual reconciliation fallback.
- Simple raw-material inventory ledger.
- Batch creation and inventory consumption on batch completion.
- Packing-ready/order-ready state.
- Dispatch, AWB and delivered state.
- Delivery-triggered refill timing.
- Refill choices: same, modify, stop.
- Role-based staff access, throttled login, forced password rotation, authenticator MFA, and session management.
- Cursor search/pagination, verified privacy requests, configurable retention, audit coverage, and a durable message outbox.
- Docker Compose, Dockerfile and Railway config.

## Deliberately not included in v1

This is not a full ERP. It intentionally leaves out procurement, supplier management, complex QC, accounting, warehouse/bin management, advanced forecasting, or an autonomous medical recommendation engine. Vaidya review remains the decision point.

## Architecture

```text
Existing ANJOORA browser questionnaire
          |
          v
ANJOORA server proxy (authenticated)
          |
          v
POST /api/v1/consultations
          |
          +--> customers
          +--> consultations + folio
          +--> review_cases
          +--> whatsapp_conversations
          |
          v
wa.me handoff / signed Meta webhook / durable outbox
          |
          v
Vaidya Operations Console
          |
          +--> recommendation
          +--> product OR personalised formula
          +--> itemized order -> customer acceptance -> payment
          +--> batch -> inventory consumption
          +--> dispatch -> delivered
          +--> refill
```

Core traceability:

```text
Customer -> Consultation -> Recommendation -> Product/Formula
         -> Order -> Batch -> Dispatch -> Refill
```

WhatsApp context:

```text
WhatsApp number -> Customer -> Active consultation -> Active order/refill
```

## Local deployment with Docker

1. Copy environment file:

```bash
cp .env.example .env
```

2. Generate and set independent values at minimum:

- `SESSION_SECRET`
- `ANJOORA_INTEGRATION_SECRET`
- `CRON_SECRET`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `ANJOORA_WHATSAPP_NUMBER`

For production, explicitly choose `PAYMENT_PROVIDER=MANUAL` or configure the external payment URL and webhook secret. Meta Cloud API values are optional as a group, but partial Meta configuration is rejected.

3. Start:

```bash
docker compose up --build
```

4. Open:

- App: `http://localhost:3000`
- Demo consultation: `http://localhost:3000/consult`
- Admin: `http://localhost:3000/admin`
- Health: `http://localhost:3000/api/health`

The app runs database migrations and bootstraps the first admin account on startup.

## Local deployment without Docker

Requires Node.js >=20.19 and PostgreSQL.

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

For production:

```bash
npm run build
npm start
```

## Railway deployment

1. Push this project to GitHub.
2. Create a new Railway project from the repository.
3. Add a PostgreSQL service.
4. Set `DATABASE_URL` to Railway's PostgreSQL connection variable.
5. Add the environment variables from `.env.example`.
6. Railway uses the included `railway.json` and `Dockerfile`.
7. Set your public domain, then set `APP_URL` and `NEXT_PUBLIC_APP_URL` to it.
8. Health check is `/api/health`.

The repository root has a Node workspace package so Railpack/Railway can detect the application even though the Next.js code lives in `web/`.

## Existing ANJOORA frontend integration

Your existing questionnaire does not need to be redesigned. Its browser submits to the ANJOORA server route `/api/consultations`; that proxy adds the server-only integration credential and calls Ops. Never expose `ANJOORA_INTEGRATION_SECRET` or call the Ops endpoint directly from browser code.

The server-to-server request is:

```http
POST /api/v1/consultations
Content-Type: application/json
X-Anjoora-Integration-Key: <server-only secret>
X-Request-Id: <correlation ID>
```

Example payload:

```json
{
  "submission_id": "6c983b5e-47f9-4f45-9a33-0cff55a70c63",
  "name": "Ananya Test",
  "whatsapp": "+919876543210",
  "city": "Test City",
  "language": "Hinglish",
  "best_time_to_message": "Afternoon",
  "primary_concern": "Sleep",
  "concerns": [
    "Calm",
    "Sleep",
    "Focus"
  ],
  "main_goal": "Fall asleep more easily",
  "duration": "Recently (less than 4 weeks)",
  "daily_effect": "A small nudge",
  "appetite_digestion": "Steady",
  "body_climate": "Usually cool",
  "energy_pattern": "quick-dip",
  "meal_rhythm": "Regular",
  "sleep_rhythm": "Regular",
  "realistic_rituals": [
    "A practical meal-based change",
    "An evening wind-down"
  ],
  "stress_response": "overthink",
  "emotional_support": "structure",
  "change_style": "small",
  "preferred_format": "infusion",
  "safety_flags": [
    "medication"
  ],
  "safety_screen_version": "1.0",
  "questionnaire_version": "1.0",
  "consent": true
}
```

Successful response:

```json
{
  "ok": true,
  "customer_id": "ANJ-C-...",
  "consultation_id": "ANJ-CON-...",
  "folio_id": "ANJ-FOL-...",
  "case_id": "ANJ-CASE-...",
  "conversation_id": "ANJ-WA-...",
  "concerns": [
    { "id": "calm", "label": "Calm", "is_primary": false, "position": 1 },
    { "id": "sleep", "label": "Sleep", "is_primary": true, "position": 2 },
    { "id": "focus", "label": "Focus", "is_primary": false, "position": 3 }
  ],
  "safety": {
    "outcome": "REVIEW_REQUIRED",
    "review_required": true,
    "urgent": false,
    "flags": ["medication"]
  },
  "folio_text": "...",
  "whatsapp_url": "https://wa.me/..."
}
```

Frontend rule:

```text
if API save succeeds -> open whatsapp_url
if API save fails    -> keep the form data and DO NOT redirect to WhatsApp
```

## WhatsApp bot setup

The project supports Meta WhatsApp Cloud API directly; no third-party bot platform is required.

Set:

```env
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_GRAPH_VERSION=v26.0
WHATSAPP_TEMPLATE_LANGUAGE=en_US
WHATSAPP_TEMPLATE_DISPATCH=
WHATSAPP_TEMPLATE_DELIVERED=
WHATSAPP_TEMPLATE_REFILL=
CRON_SECRET=replace-with-a-long-random-secret
```

Configure the Meta webhook URL as:

```text
https://YOUR_DOMAIN/api/webhooks/whatsapp
```

Use the same value for Meta webhook verification token and `WHATSAPP_VERIFY_TOKEN`.

Subscribe the WhatsApp Business Account to incoming message/webhook events.

For proactive dispatch, delivery or refill reminders, configure approved WhatsApp message-template names in the template environment variables. The supplied parameters are documented in `docs/WHATSAPP.md`.

### v1 bot intents

The bot recognizes:

- Consultation status
- Add information
- Vaidya clarification reply
- Order / dispatch status
- Refill / reorder intent
- Human support request
- Other/personal recommendation questions -> human handoff

The bot reads status from the backend; it does not invent consultation or order status.

### Safety/product rule

Personal recommendation, formulation changes or other messages requiring practitioner judgment are routed to a human Vaidya rather than answered autonomously.

## Required operational jobs

Run the durable message worker at least once per minute:

```http
POST /api/jobs/outbox?limit=100
Authorization: Bearer YOUR_CRON_SECRET
```

Call the protected endpoint once daily from Railway Cron or another scheduler:

```http
POST /api/jobs/refills
Authorization: Bearer YOUR_CRON_SECRET
```

It refreshes due/due-soon refill statuses and, when `WHATSAPP_TEMPLATE_REFILL` is configured, sends the approved refill template.

Run the retention/session cleanup once daily:

```http
POST /api/jobs/maintenance
Authorization: Bearer YOUR_CRON_SECRET
```

See `docs/OPERATIONS_RUNBOOK.md` for alerts, retention, backup, and restore-drill procedures.

## Admin workflow

### Consultations

`/admin/consultations`

Vaidya can:

- open folio
- see the primary concern, ordered linked concerns and safety flags
- filter the queue by concern and safety outcome
- request clarification (sent to WhatsApp when Cloud API is configured)
- mark ready for recommendation
- hold
- close
- review customer-supplied WhatsApp notes

### Recommendation

Inside consultation detail:

- create recommendation summary
- choose standard product or personalised formula
- set duration
- enter usage instructions
- enter formula ingredients

Ingredient format:

```text
SKU | Name | Qty | Unit
RM-ASHWAGANDHA | Ashwagandha | 30 | g
RM-BRAHMI | Brahmi | 20 | g
```

If the SKU exists in inventory, it is linked for batch consumption.

### Orders

A current approved recommendation can be converted to an itemized order from the consultation page. The customer must accept the secure link and payment must be verified before stock allocation or production can start.

### Inventory

`/admin/inventory`

Supports:

- create/update inventory item
- stock receipt
- signed adjustment
- calculated available stock from the inventory ledger

### Batches

`/admin/batches`

- create one batch from a paid personalised order public ID
- formula-linked inventory items are copied into batch requirements
- production quantity is derived from the order; wastage is explicit
- complete batch
- system checks stock
- stock is consumed from the ledger
- order moves to ready for dispatch

### Dispatch

`/admin/dispatch`

- courier
- AWB
- dispatched status
- delivered status
- optional WhatsApp milestone message
- delivery automatically creates refill timing

### Refills

`/admin/refills`

Choices:

- **Same** -> creates at most one new order using the same recommendation/items; customer acceptance and payment are required again
- **Modify** -> sends the source consultation back to the review queue and records a modification request
- **Stop** -> closes the refill

### WhatsApp Inbox

`/admin/whatsapp`

Shows:

- customer
- active folio/order context
- conversation status
- human handoff flag
- inbound/outbound message history
- human reply form

## Database migration strategy

SQL migrations live in:

```text
web/db/migrations/
```

`npm start` runs migrations under a PostgreSQL advisory lock before the Next.js server starts.

Applied migration names are stored in `schema_migrations`.

## Seed data

Optional demo product/inventory records:

```bash
npm run db:seed
```

Seed data is for technical testing only and is not a clinical or formulation recommendation.

## Production checklist

Before live customer use:

- replace bootstrap admin password
- use a long random `SESSION_SECRET`
- use different random integration and cron secrets
- require password rotation and MFA for every staff account
- configure managed PostgreSQL backups
- enable verified PostgreSQL TLS and provide the provider CA when required
- configure a permanent Meta system-user access token
- set Meta app secret for webhook signature verification
- set the production WhatsApp number
- test webhook verification and inbound message processing
- schedule and monitor outbox, refill, and maintenance jobs
- test a full consultation -> recommendation -> acceptance -> payment -> batch/stock -> dispatch -> refill cycle
- run an isolated restore drill and record the evidence
- connect the existing ANJOORA questionnaire to the consultation API
- review privacy notice/consent wording for the production jurisdiction and actual data use

## Files to read next

- `docs/PRODUCT_WORKFLOW.md`
- `docs/API.md`
- `docs/WHATSAPP.md`
- `docs/DEPLOYMENT.md`
- `docs/OPERATIONS_RUNBOOK.md`
