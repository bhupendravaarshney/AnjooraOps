# ANJOORA Ops Deployment

## Production shape

```text
ANJOORA web/mobile browser
  -> ANJOORA HTTPS server proxy
      -> authenticated ANJOORA Ops intake

Staff browser
  -> ANJOORA Ops HTTPS service
      -> private managed PostgreSQL
      -> durable outbox -> Meta WhatsApp Cloud API
      -> configured payment checkout + signed webhook

Scheduler
  -> outbox every minute
  -> refill and maintenance daily
```

The native wrappers continue to use the deployed ANJOORA web domain. No mobile/browser bundle receives database, integration, cron, payment, or Meta secrets.

## Required environment

Core production values:

```text
APP_URL
NEXT_PUBLIC_APP_URL
DATABASE_URL
DATABASE_SSL
SESSION_SECRET
ANJOORA_INTEGRATION_SECRET
CRON_SECRET
ANJOORA_WHATSAPP_NUMBER
ENABLE_DEMO_FORM=false
PAYMENT_PROVIDER
GO_LIVE=false
RELEASE_CANDIDATE
```

Use distinct random values of at least 32 characters for the session, integration, and cron secrets. `DATABASE_SSL=true` verifies the server certificate; set `DATABASE_CA_CERT` when the provider CA is not in the system trust store.

Run `npm run config:validate` with the deployment environment before release. Non-local production validation fails unless database TLS verification is enabled and rejects placeholder application or database credentials.

For an external payment provider, also set:

```text
PAYMENT_LINK_BASE_URL=https://...
PAYMENT_WEBHOOK_SECRET=...
```

Set `PAYMENT_PROVIDER=MANUAL` only when an administrator will independently reconcile every payment. Production never treats an order as paid merely because a staff member created it or a customer accepted it.

Meta Cloud API is optional as one complete group:

```text
WHATSAPP_VERIFY_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_GRAPH_VERSION
```

If any required Meta value is present, all must be present. Configure approved dispatch, delivery, and refill templates for proactive messages.

An external payment integration uses a reviewed normalizer/adapter. Set `PAYMENT_ADAPTER_ID` to its deployed version and `PAYMENT_EVENT_MAP` to a JSON object mapping the provider's real event names to `PENDING`, `PAID`, `FAILED`, `CANCELLED`, and `REFUNDED`. The adapter verifies the provider-native webhook before signing the canonical request to Ops with `PAYMENT_WEBHOOK_SECRET`.

Before `GO_LIVE=true`, also set the immutable `RELEASE_CANDIDATE`, business-approved `BACKUP_RPO_HOURS`, `BACKUP_RTO_MINUTES`, `CONSULTATION_CONSENT_VERSION`, `CONSULTATION_CONSENT_TEXT`, `PRIVACY_IDENTITY_VERIFICATION_METHOD`, `PRIVACY_APPROVAL_ID`, `PRIVACY_APPROVED_AT`, and retention values. Go-live validation requires the live external payment provider, complete Meta credentials/templates, and removal of the bootstrap email/password. The final audit rejects evidence prepared for a different release candidate.

## Startup behavior

`npm start`:

1. loads the untracked local `.env` only when process environment values are absent;
2. validates the deployment profile and rejects unsafe production configuration;
3. applies ordered SQL migrations while holding a PostgreSQL advisory lock;
4. creates the bootstrap administrator only when the email does not already exist;
5. starts the Next.js production server.

Bootstrap never silently changes an existing account. The P0 credential-revalidation migration revokes existing sessions and requires every active account present at upgrade time to rotate its password once; new bootstrap accounts also require rotation. Use `npm run staff:manage --workspace=web` with `STAFF_ACTION=list|audit|create|update|reset|recover|deactivate` and the documented `STAFF_*` environment variables for explicit account administration.

The staff tool additionally supports `list`, `audit`, `update`, and `recover`. Every mutation requires a named `STAFF_OPERATOR`; recovery also requires `STAFF_RECOVERY_APPROVAL_REF`. Both are written to the audit event. `audit` compares the database with `STAFF_REGISTER_FILE`; `update` changes the named identity/role and revokes sessions; `recover` revokes sessions and forces password rotation.

## Docker Compose development

The supplied Compose profile binds PostgreSQL only to `127.0.0.1`, uses a health-gated startup, and runs the application as an unprivileged user. Its local-only scheduler runs the outbox every minute and the refill/maintenance jobs daily, starts only after the app is healthy, and refuses a go-live environment. Production still requires the approved external scheduler and alerting service described below.

```powershell
docker compose up --build -d
docker compose ps
npm run verify
npm run test:http
npm run ops:restore-test
```

`npm run test:http` is guarded to localhost by default and removes its test customers/jobs. `npm run ops:restore-test` creates and drops only a randomly named isolated restore database.

## Railway or another Docker host

1. Build from the repository `Dockerfile`; it uses the lockfile and `npm ci`.
2. Attach private managed PostgreSQL and inject environment values through the platform secret store.
3. Expose only the application port over HTTPS.
4. Configure `/api/health` as the service health check.
5. Configure the ANJOORA server proxy with the Ops URL and the same integration secret.
6. Register the signed Meta and payment webhook URLs only after their secrets are present.
7. Attach the required scheduler calls and alerting from `OPERATIONS_RUNBOOK.md`.
8. Enable managed backups/PITR and complete an isolated restore drill before launch.

Create separate scheduler services from the same release image, sharing only `APP_URL` and `CRON_SECRET` as required, with these commands:

```text
npm run job:outbox       # every minute
npm run job:refills      # daily
npm run job:maintenance  # daily
npm run ops:status       # every minute; alert on non-zero exit
```

## Release verification

Run against the release database/environment:

```powershell
npm ci
npm run config:validate
npm run db:migrate
npm run verify
npm run build
npm run test:http
npm run test:payment-http
```

Also run `npm run verify` in the ANJOORA frontend and verify its `/api/consultations` proxy against the release Ops instance. Its configuration gate rejects leaked public secrets and unsafe Ops endpoints. The Ops test suite includes validation, IDs/cursors, security primitives, workflow transitions, clean-database migrations, constraints, duplicate protection, immutable inventory, and concurrent stock consumption. The live smoke covers intake auth/idempotency, exact server-owned consent text/version, CSRF, headers, the ANJOORA proxy, signed WhatsApp replay, and failure callbacks.

Run `test:payment-http` only against an isolated release environment configured with the reviewed adapter contract. It creates and removes uniquely identified fixtures and covers invalid signature, paid, failed, cancelled, full and partial refund handling, duplicate, delayed, amount/reference mismatch, and invalid-precision events.

After the provider tests and restore drill have produced evidence, set `GO_LIVE=true`, provide the approved private `STAFF_REGISTER_FILE` and `RELEASE_EVIDENCE_FILE`, then run `npm run release:audit`. The example schemas are in `docs/staff-register.example.json` and `docs/release-evidence.example.json`; their placeholders intentionally fail.

## Rollback and migrations

Migrations are forward-only and recorded in `schema_migrations`. Do not delete migration rows or edit a migration already applied to a shared environment. Roll application code back only when it remains compatible with the migrated schema. For a destructive schema recovery, restore a verified backup into an isolated database first and follow an approved incident plan.

## Operations handoff

Read [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) before launch. Provider-owned backup, alert, Meta template, payment contract, and legal-retention controls require named owners and cannot be activated by repository code alone.
