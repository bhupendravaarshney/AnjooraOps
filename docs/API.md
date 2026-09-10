# ANJOORA Ops API

## Consultation intake

### `POST /api/v1/consultations`

This is a server-to-server endpoint. Browser code calls the ANJOORA frontend route `/api/consultations`; the frontend proxy forwards the validated payload with:

```http
Content-Type: application/json
X-Anjoora-Integration-Key: <ANJOORA_INTEGRATION_SECRET>
X-Anjoora-Client-Ip: <customer IP supplied by the trusted proxy>
X-Request-Id: <8-100 character correlation ID>
```

The body is limited to 32 KiB. Unknown fields, unsupported allowlist values, excessive lengths, invalid phone numbers, missing consent, and unsupported questionnaire versions return an error. Required fields are:

- `submission_id`: client-generated UUID retained across retries
- `name`
- `whatsapp`: supported Indian mobile form or international E.164 number
- `primary_concern`
- `concerns`: ordered array of one to four supported concern labels containing the primary concern
- `safety_flags`: one or more supported identifiers
- `questionnaire_version: "1.0"`
- `safety_screen_version: "1.0"`
- `consent: true`
- `consent_version`: the version returned by `GET /api/v1/consent`

The legacy `concern` field remains accepted as one primary concern. If an older client omits `safety_flags`, Ops records `not-provided` and requires human safety review.

Supported safety identifiers are `none`, `medication`, `pregnancy`, `allergy`, `child`, `urgent-chest`, `urgent-neuro`, and `urgent-bleeding`. `none` cannot be combined with another flag. Urgent flags block recommendation approval and order creation.

Example:

```json
{
  "submission_id": "6c983b5e-47f9-4f45-9a33-0cff55a70c63",
  "name": "Ananya Test",
  "whatsapp": "+91 98765 43210",
  "language": "Hinglish",
  "best_time_to_message": "Afternoon",
  "primary_concern": "Sleep",
  "concerns": ["Calm", "Sleep", "Focus"],
  "safety_flags": ["medication"],
  "preferred_format": "Botanical infusion",
  "questionnaire_version": "1.0",
  "safety_screen_version": "1.0",
  "consent": true,
  "consent_version": "2026-09-v1"
}
```

A new submission returns HTTP 201. An exact retry returns HTTP 200, the original consultation response, and `Idempotent-Replayed: true`. The service owns the consent text/version and does not overwrite an existing customer's identity or clear a human escalation.

### `GET /api/v1/consent`

Returns the current server-owned `{ "version", "text" }` policy with `Cache-Control: no-store`. ANJOORA proxies this response to its browser UI. Intake rejects a stale or missing version so the recorded text cannot silently differ from what the customer reviewed.

## Public customer endpoints

### `POST /api/orders/accept`

Accepts the single-use order link form. It requires same-origin submission, explicit acceptance, and a valid random token. It records versioned acceptance evidence, moves the order to `AWAITING_PAYMENT`, and creates at most one pending payment intent.

### `POST /api/webhooks/payments`

Receives the reviewed provider-adapter payload, limited to 64 KiB and signed as `sha256=<HMAC-SHA256(raw body)>` in `X-Payment-Signature`. Required fields are `provider`, `event_id`, `event_type`, and `intent_reference`. `provider` must exactly match `PAYMENT_PROVIDER`, and `event_type` is mapped by `PAYMENT_EVENT_MAP` to `PENDING`, `PAID`, `FAILED`, `CANCELLED`, or `REFUNDED`. Paid and refunded events must also contain `amount`, `currency`, and the original payment `provider_reference`; the distinct refund identifier remains in `event_id`.

Provider event IDs are unique. Exact replays return a duplicate acknowledgement. Delayed failed/pending events cannot downgrade a paid or fulfilled order. Suspicious ordering or amount/currency/reference mismatch, including a partial refund, creates review-required work instead of changing fulfilment. A database trigger independently rejects `IN_PRODUCTION`, `READY_TO_DISPATCH`, `SHIPPED`, or new `DELIVERED` state unless `payment_status=PAID`.

The repository defines and tests the canonical adapter contract and state handling. The adapter must verify the selected provider's native signature and normalize its native payload before signing the Ops request. The production payment account, checkout URL, adapter version, real event mapping, and reconciliation still have to be configured and certified with that provider.

## WhatsApp webhook

### `GET /api/webhooks/whatsapp`

Meta webhook verification using `WHATSAPP_VERIFY_TOKEN`.

### `POST /api/webhooks/whatsapp`

The payload is limited to 1 MiB and must carry a valid Meta `X-Hub-Signature-256` whenever the webhook is enabled. Each Meta message ID is stored once. New inbound messages enqueue a durable `BOT_INBOUND` job; a replay performs no bot action. Delivery, read, and failure callbacks update the exact outbound message. A failure callback makes an accepted outbox job retryable without hiding the failure state.

## Staff form endpoints

All mutation routes require a valid staff session, same-origin form submission, expected current state where applicable, and the required role:

| Endpoint | Roles |
|---|---|
| `POST /api/admin/review` | Admin, Vaidya |
| `POST /api/admin/recommendations` | Admin, Vaidya |
| `POST /api/admin/orders` | Admin, Operations; manual paid reconciliation is Admin-only |
| `POST /api/admin/inventory` | Admin, Operations |
| `POST /api/admin/batches` | Admin, Operations |
| `POST /api/admin/dispatch` | Admin, Operations |
| `POST /api/admin/refills` | Admin, Operations |
| `POST /api/admin/whatsapp/send` | Admin, Support, Vaidya |
| `POST /api/admin/privacy` | Admin |
| `POST /api/admin/staff` | Admin |

Unknown actions return HTTP 422. Stale or invalid workflow transitions return HTTP 409. Successful repeated actions are idempotent and do not create duplicate orders, batches, inventory issues, dispatches, refills, reminders, or messages.

Personalised recommendation requests send paired `formula_ingredient_id` and `formula_ingredient_quantity` values. The server resolves active catalogue entries, stores their catalogue/inventory identities and name/unit snapshot, and obtains the canonical SKU through the inventory relationship; client-supplied ingredient descriptions are not trusted. Inventory actions `upsert_formula_ingredient` and `set_formula_ingredient_active` maintain this catalogue.

The staff endpoint supports `create`, `update`, `reset`, and `deactivate`. It requires the administrator-only `STAFF_MANAGEMENT` capability, audits each accepted or rejected operation, forces temporary-password rotation, and revokes sessions after access or credential changes. `SUPPORT` has Dashboard and WhatsApp capabilities only.

## Authentication endpoints

- `POST /api/auth/login`: same-origin login, database-backed IP throttling, account lockout, and optional TOTP proof.
- `POST /api/auth/logout`: removes the current server-side session.
- `POST /api/auth/password`: verifies the current password, enforces policy, rotates the password, and revokes all sessions.
- `POST /api/auth/mfa`: enables TOTP after code proof. Disabling requires password plus code proof and is rejected while mandatory staff MFA is enabled; audited account recovery is used instead.
- `POST /api/auth/sessions`: revokes an authorized session.

## Protected jobs

All jobs require `Authorization: Bearer <CRON_SECRET>`.

- `POST /api/jobs/outbox?limit=100`: claims retryable jobs with `SKIP LOCKED`, processes inbound automation or Meta delivery, and records bounded failure/dead state.
- `POST /api/jobs/refills`: updates due states using `REFILL_REMINDER_DAYS_BEFORE` and queues one reminder event per refill due date.
- `POST /api/jobs/maintenance`: removes expired sessions/rate events, purges configured raw payloads and old message bodies, prunes terminal outbox rows, respects legal holds, and reports structured records due for lifecycle review.
- `GET /api/jobs/status`: returns HTTP 503 with stable issue codes when job runs are overdue/stalled or application-visible alert backlogs exist.

Each POST execution creates a durable `operational_job_runs` record. Provider-owned database capacity and backup monitors remain external checks.

## Health

### `GET /api/health`

Returns HTTP 200 with `{ "ok": true, "service": "anjoora-ops" }` when the application can query PostgreSQL. Failure returns a generic HTTP 503 response; database details are logged only server-side.
