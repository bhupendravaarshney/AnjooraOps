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
REQUIRE_STAFF_MFA=true
ENABLE_DEMO_FORM=false
PAYMENT_PROVIDER
```

Use distinct random values of at least 32 characters for the session, integration, and cron secrets. `DATABASE_SSL=true` verifies the server certificate; set `DATABASE_CA_CERT` when the provider CA is not in the system trust store.

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
WHATSAPP_GRAPH_VERSION
```

If any required Meta value is present, all must be present. Configure approved dispatch, delivery, and refill templates for proactive messages.

## Startup behavior

`npm start`:

1. loads the untracked local `.env` only when process environment values are absent;
2. validates the deployment profile and rejects unsafe production configuration;
3. applies ordered SQL migrations while holding a PostgreSQL advisory lock;
4. creates the bootstrap administrator only when the email does not already exist;
5. starts the Next.js production server.

Bootstrap never silently changes an existing account. New bootstrap accounts must rotate the temporary password. Use `npm run staff:manage --workspace=web` with `STAFF_ACTION=create|reset|deactivate` and the documented `STAFF_*` environment variables for explicit account administration.

## Docker Compose development

The supplied Compose profile binds PostgreSQL only to `127.0.0.1`, uses a health-gated startup, and runs the application as an unprivileged user.

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

## Release verification

Run against the release database/environment:

```powershell
npm ci
npm run db:migrate
npm run verify
npm run build
npm run test:http
```

Also build the ANJOORA frontend and verify its `/api/consultations` proxy against the release Ops instance. The test suite includes validation, IDs/cursors, security primitives, workflow transitions, clean-database migrations, constraints, duplicate protection, immutable inventory, and concurrent stock consumption. The live smoke covers intake auth/idempotency, CSRF, headers, the ANJOORA proxy, signed WhatsApp replay, and failure callbacks.

## Rollback and migrations

Migrations are forward-only and recorded in `schema_migrations`. Do not delete migration rows or edit a migration already applied to a shared environment. Roll application code back only when it remains compatible with the migrated schema. For a destructive schema recovery, restore a verified backup into an isolated database first and follow an approved incident plan.

## Operations handoff

Read [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) before launch. Provider-owned backup, alert, Meta template, payment contract, and legal-retention controls require named owners and cannot be activated by repository code alone.
