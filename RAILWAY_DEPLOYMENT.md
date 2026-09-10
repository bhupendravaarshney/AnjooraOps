# Deploy AnjooraOps on Railway

Last verified: **9 September 2026**

This guide deploys the `AnjooraOps` repository as a Railway web service with a
private PostgreSQL service. It is specific to this repository's `Dockerfile`,
startup scripts, environment validation, migrations, staff bootstrap, protected
jobs, and health endpoint.

The deployment described here starts in **pre-live/staging mode** with
`GO_LIVE=false`. A successful Railway deployment is not production approval.
The external release gates in [issue.md](issue.md) must be completed with real
evidence before enabling live traffic.

## Target layout

~~~text
Customer browser
  -> Anjoora customer web service
      -> AnjooraOps public HTTPS service
          -> Railway private PostgreSQL

Staff browser
  -> AnjooraOps /admin/login

Meta WhatsApp and the payment provider
  -> AnjooraOps signed webhook endpoints

Approved external scheduler/monitor
  -> AnjooraOps protected job and status endpoints
~~~

For the complete product, deploy `Anjoora` and `AnjooraOps` as separate web
services. Only `AnjooraOps` connects to PostgreSQL.

## Important: how to use `railway.json`

Railway's legacy Config as Code feature is now deprecated. New services cannot
opt into `railway.json` or `railway.toml`; existing services that already use
them stop being supported at the **2026-12-01 hard cutoff**. Railway recommends
the newer `.railway/railway.ts` Infrastructure as Code format.

Therefore, for a new deployment:

- Keep [railway.json](railway.json) as a readable reference.
- Configure the equivalent settings in the Railway dashboard as documented
  below.
- Do not assume Railway has applied `railway.json`; inspect the deployment
  details after deploying.
- Migration to `.railway/railway.ts` is a separate infrastructure change. Do
  not block the first staging deployment on it.

See Railway's current
[Config as Code notice](https://docs.railway.com/config-as-code).

## 1. Prepare the repository

Use the standalone GitHub repository for AnjooraOps:

~~~text
https://github.com/bhupendravaarshney/AnjooraOps
~~~

Railway deploys committed GitHub content, not uncommitted files on this
computer. From the `AnjooraOps` directory, review and test the exact release:

~~~powershell
git status --short
npm ci
npm run verify
npm run build
docker build --tag anjoora-ops:railway .
~~~

Commit only the reviewed release files, then push the intended branch. Avoid a
blind `git add .` when the working tree contains unrelated changes.

Do not commit `.env`, production staff registers, release evidence, downloaded
certificates, passwords, access tokens, or provider secrets.

## 2. Create the Railway project and environment

1. Sign in at [Railway](https://railway.com/) and connect the GitHub account
   that can read the AnjooraOps repository.
2. Create an empty Railway project, for example `anjoora`.
3. Create or select a `staging` environment first.
4. Keep production and staging variables, databases, domains, and evidence
   separate.

Railway collects configuration changes as staged changes. Review them and click
**Deploy** when the related service, variables, and settings are ready.

## 3. Add private PostgreSQL

1. On the project canvas, choose **New -> Database -> PostgreSQL**.
2. Name the service `Postgres`. If a different name is used, substitute that
   exact name in every `${{Postgres.VARIABLE}}` reference below.
3. Wait until the database deployment is healthy.
4. Do not add public TCP access. AnjooraOps should use the private
   `DATABASE_URL`.
5. Enable the backup and point-in-time-recovery options supported by the
   selected Railway plan. A restore rehearsal is still required before go-live.

Railway documents its PostgreSQL template and connection variables in
[PostgreSQL](https://docs.railway.com/databases/postgresql).

### Install the PostgreSQL root CA

This repository deliberately uses `rejectUnauthorized: true` for PostgreSQL.
The Railway PostgreSQL template enables TLS with its own root CA, so
`DATABASE_SSL=true` alone is not sufficient: AnjooraOps must also trust the
database's actual root certificate.

Install and authenticate the Railway CLI on this Windows machine:

~~~powershell
npm install --global @railway/cli
railway login
Set-Location C:\Users\bhupe\Downloads\Anjoora-release\AnjooraOps
railway link
~~~

Select the new project and the `staging` environment. Download only the public
root certificate from the running PostgreSQL service:

~~~powershell
railway service files download --service Postgres --environment staging /var/lib/postgresql/data/certs/root.crt .\railway-postgres-root.crt
Get-Content -Raw .\railway-postgres-root.crt | Set-Clipboard
~~~

In the AnjooraOps service's **Variables** tab, create
`DATABASE_CA_CERT` and paste the complete PEM value, including the
`BEGIN CERTIFICATE` and `END CERTIFICATE` lines. Railway supports multiline
variables. Remove the downloaded local copy after confirming the deployed
service works, and never commit it.

The certificate path comes from Railway's official
[SSL PostgreSQL image](https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh).
The CLI file-download syntax is documented under
[railway service files](https://docs.railway.com/cli/service).

Important:

- Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Do not change `DATABASE_SSL` to `false`.
- Do not replace full verification with `sslmode=require`.
- Use `${{Postgres.DATABASE_URL}}`, not `DATABASE_PUBLIC_URL`.
- Monitor certificate expiry. If the PostgreSQL template rotates its root CA,
  download the new `root.crt`, replace `DATABASE_CA_CERT`, and redeploy
  AnjooraOps before the old certificate expires.

If the CA cannot be retrieved or verified, stop the deployment and resolve that
with Railway support or use a managed PostgreSQL provider with a documented CA.
Do not weaken the application's TLS policy.

## 4. Create the AnjooraOps service

1. Choose **New -> Empty Service** and name it `anjoora-ops`.
2. Open **Settings -> Source**, select **Connect Repo**, and choose
   `bhupendravaarshney/AnjooraOps`.
3. Select the intended branch, normally `main`.
4. Set **Root Directory** to `/`. Do not set it to `/web`; the root
   `package.json` is the npm workspace entry point.
5. Confirm Railway detects `/Dockerfile`. Railway detects a root Dockerfile
   automatically.
6. Under **Networking -> Public Networking**, choose **Generate Domain**.

If AnjooraOps is instead stored inside a larger monorepo, use
`/AnjooraOps` as the root directory. The standalone GitHub repository uses `/`.

Railway's service and Dockerfile behavior is documented in
[Services](https://docs.railway.com/services) and
[Dockerfiles](https://docs.railway.com/builds/dockerfiles).

## 5. Configure build and deploy settings

Configure these settings manually for a new service:

| Setting | Value |
|---|---|
| Builder | Dockerfile |
| Dockerfile path | `/Dockerfile` |
| Start command | `npm start` |
| Health-check path | `/api/health` |
| Health-check timeout | `120` seconds |
| Restart policy | On Failure |
| Maximum restart retries | `10` |

Leaving the start-command field empty also uses the Dockerfile's
`CMD ["npm", "start"]`, but setting `npm start` explicitly matches the old
`railway.json`.

Do not configure a pre-deploy migration command. This repository's `npm start`
already validates configuration, applies migrations under a PostgreSQL
advisory lock, checks the bootstrap administrator, and then starts Next.js.

Do not set `PORT`; Railway injects it and the application already listens on
that value.

Do not deploy `docker-compose.yml` to Railway. Compose is for local use; Railway
represents the app, database, and scheduled jobs as separate services. See
[Deploying Docker Compose to Railway](https://docs.railway.com/guides/docker-compose).

## 6. Add pre-live variables

Open the `anjoora-ops` service's **Variables** tab. Add the following minimum
pre-live configuration. Values inside angle brackets are instructions and must
be replaced; they are not valid values.

| Variable | Pre-live value or source |
|---|---|
| `NODE_ENV` | `production` |
| `GO_LIVE` | `false` |
| `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `NEXT_PUBLIC_APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `DATABASE_SSL` | `true` |
| `DATABASE_CA_CERT` | Complete Railway PostgreSQL `root.crt` PEM |
| `SESSION_SECRET` | A unique cryptographically random value of at least 32 characters |
| `ANJOORA_INTEGRATION_SECRET` | A different random value of at least 32 characters |
| `CRON_SECRET` | A third different random value of at least 32 characters |
| `BOOTSTRAP_ADMIN_EMAIL` | The real initial administrator email |
| `BOOTSTRAP_ADMIN_PASSWORD` | A unique 32+ character temporary password containing uppercase, lowercase, a number, and a symbol |
| `REQUIRE_STAFF_MFA` | `true` |
| `ENABLE_DEMO_FORM` | `false` |
| `ANJOORA_WHATSAPP_NUMBER` | The real country-code number, digits only, 10-15 digits |
| `WHATSAPP_FOLIO_MODE` | `full` |
| `PAYMENT_PROVIDER` | `MANUAL` for pre-live provisioning only |

Use Railway reference-variable autocomplete when entering
`${{Postgres.DATABASE_URL}}` and `${{RAILWAY_PUBLIC_DOMAIN}}`. Reference
variables avoid copying database credentials and keep domain values in sync.
See [Using Variables](https://docs.railway.com/variables) and
[Variables Reference](https://docs.railway.com/variables/reference).

The following should not be added to the AnjooraOps app service:

- `PORT`: Railway supplies it.
- `POSTGRES_PASSWORD`: it belongs to the PostgreSQL service; use the
  `DATABASE_URL` reference.
- `DEPLOYMENT_PROFILE=local`: the local profile must never be used on Railway.
- Any secret whose name starts with `NEXT_PUBLIC_`.

Generate every secret independently with a password manager or cryptographic
secret generator. Do not reuse the session, integration, cron, bootstrap,
payment, or Meta secrets.

After verifying values, seal sensitive Railway variables if that fits the
team's recovery process. Remember that Railway does not automatically copy
sealed values to duplicated or PR environments.

### Optional Meta WhatsApp variables

Leave all Meta values absent during initial provisioning, or set the complete
group together:

~~~text
WHATSAPP_VERIFY_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_GRAPH_VERSION
~~~

A partial group is rejected. Go-live additionally requires approved values for:

~~~text
WHATSAPP_TEMPLATE_DISPATCH
WHATSAPP_TEMPLATE_DELIVERED
WHATSAPP_TEMPLATE_REFILL
~~~

### External payment variables

`PAYMENT_PROVIDER=MANUAL` is allowed only while staging is being provisioned.
When the real provider is selected, configure:

~~~text
PAYMENT_PROVIDER=<actual provider name, not EXTERNAL>
PAYMENT_LINK_BASE_URL=<real HTTPS checkout base URL>
PAYMENT_WEBHOOK_SECRET=<independent random secret of at least 32 characters>
PAYMENT_ADAPTER_ID=<reviewed adapter name/version>
PAYMENT_EVENT_MAP=<JSON map for provider events>
~~~

`GO_LIVE=true` rejects both `MANUAL` and the placeholder name `EXTERNAL`.

## 7. Deploy and inspect startup

Review the staged Railway changes and click **Deploy**. The Docker image uses
Node 24 and `npm ci`, then `npm start` performs this sequence:

1. Validate all production environment variables.
2. Apply ordered SQL migrations while holding an advisory lock.
3. Create the bootstrap administrator only when its email does not already
   exist.
4. Start Next.js on Railway's injected `PORT`.

Watch the deployment logs in the dashboard. With the CLI:

~~~powershell
railway logs --service anjoora-ops --environment staging --lines 200
~~~

The deployment should show successful pre-live environment validation,
successful migrations, the bootstrap check, and the running Next.js server.
Any `Configuration error` must be fixed at its source; repeated restarts will
not repair a missing or unsafe variable.

Railway requires a 2xx response from `/api/health` before switching traffic.
That endpoint also queries PostgreSQL, so it verifies both the web process and
the database connection. See
[Healthchecks](https://docs.railway.com/deployments/healthchecks).

## 8. Verify the staging deployment

Replace the sample host with the generated Railway domain:

~~~powershell
curl.exe --fail --show-error --silent https://YOUR-SERVICE.up.railway.app/api/health
~~~

Expected response:

~~~json
{"ok":true,"service":"anjoora-ops"}
~~~

Also run configuration validation inside the deployed container:

~~~powershell
railway ssh --service anjoora-ops --environment staging -- npm run config:validate
~~~

Then complete the administrator setup:

1. Open `https://YOUR-SERVICE.up.railway.app/admin/login`.
2. Sign in with the one-time bootstrap administrator.
3. Replace the temporary password when prompted.
4. Enroll authenticator MFA.
5. Open `/admin/staff` and create each approved named staff account with the
   smallest suitable role.
6. Verify that a `SUPPORT` account can access only Dashboard and WhatsApp.
7. Delete `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from Railway
   and redeploy.
8. Confirm the rotated administrator login still works after that redeploy.

Removing bootstrap variables does not delete the persisted administrator.
Startup migrations are idempotent, and the bootstrap insert never changes an
existing account.

## 9. Connect the Anjoora customer service

Deploy the customer-facing `Anjoora` repository as a second Railway service.
Its Next.js application is under that repository's `/web` directory. Configure
these server-side variables:

~~~text
GO_LIVE=false
ANJOORA_OPS_API_URL=https://${{anjoora-ops.RAILWAY_PUBLIC_DOMAIN}}
ANJOORA_INTEGRATION_SECRET=<the exact same value used by AnjooraOps>
~~~

Use Railway's autocomplete for the AnjooraOps domain reference. A project-level
shared variable is suitable for `ANJOORA_INTEGRATION_SECRET` when both services
are in the same Railway project.

Never rename either setting to `NEXT_PUBLIC_*`; the integration secret must
remain server-only. Redeploy the customer service after changing these values,
then submit a staging consultation and verify that it appears in the
AnjooraOps staff console.

For a custom production domain, update both `APP_URL` and
`NEXT_PUBLIC_APP_URL` to the same canonical HTTPS origin and redeploy. Railway
provisions TLS for verified custom domains; see
[Working with Domains](https://docs.railway.com/networking/domains/working-with-domains).

## 10. Configure jobs and continuous monitoring

This is a release-critical detail: Railway cron jobs have a **minimum
five-minute interval**, use UTC, can run a few minutes late, and skip a new run
when the previous run is still active. The AnjooraOps outbox and status checks
are required every minute, so Railway Cron alone cannot satisfy `LIVE-004`.

Use an approved external scheduler/monitor that supports one-minute execution
and authenticated headers for:

| Request | Schedule | Required behavior |
|---|---:|---|
| `POST /api/jobs/outbox?limit=100` | Every minute | Send `Authorization: Bearer <CRON_SECRET>` and alert on failure/dead messages |
| `GET /api/jobs/status` | Every minute | Send the bearer secret and alert on HTTP 503 or returned issue codes |
| `GET /api/health` | Every minute | No authentication; alert after the approved failure threshold |

Railway's platform health check protects a deployment transition; it is not a
continuous uptime monitor.

Railway Cron can be used for the two daily jobs. Create a separate service for
each job from the same AnjooraOps repository and Dockerfile. Give neither
service a public domain.

| Service | Start command | Example UTC cron |
|---|---|---|
| `job-refills` | `npm run job:refills` | `30 18 * * *` (00:00 IST) |
| `job-maintenance` | `npm run job:maintenance` | `0 19 * * *` (00:30 IST) |

Each daily job service needs only:

~~~text
APP_URL=https://${{anjoora-ops.RAILWAY_PUBLIC_DOMAIN}}
CRON_SECRET=<reference the same protected secret>
~~~

The command calls the public protected endpoint and exits. Do not add a cron
schedule to the main `anjoora-ops` web service, because the web service must
remain running.

See [Railway Cron Jobs](https://docs.railway.com/cron-jobs) and the repository's
[Operations runbook](docs/OPERATIONS_RUNBOOK.md).

## 11. Configure provider callbacks

Only after the corresponding credentials and signing secrets are present,
register these public HTTPS callbacks:

~~~text
Meta WhatsApp verification and events:
GET/POST https://YOUR_OPS_DOMAIN/api/webhooks/whatsapp

Payment provider events:
POST https://YOUR_OPS_DOMAIN/api/webhooks/payments
~~~

Complete real provider verification, replay/duplicate tests, failure callbacks,
template approval, and evidence collection before setting `GO_LIVE=true`.

## 12. Backups, restore, and go-live

Before handling live customer data:

1. Enable automatic encrypted backups and point-in-time recovery.
2. Approve and set `BACKUP_RPO_HOURS` and `BACKUP_RTO_MINUTES`.
3. Restore a backup into a new isolated database, never over production.
4. Run `npm run ops:restore-validate` against the isolated restore.
5. Connect database-capacity, backup-age/failure, job, payment, WhatsApp, and
   inventory alerts to named on-call owners.
6. Complete all remaining items in [issue.md](issue.md).
7. Store the real staff register and release evidence outside source control.
8. Run the release audit against the immutable release candidate.

Keep `GO_LIVE=false` until the payment provider, complete Meta configuration,
approved privacy/consent values, recovery objectives, staff MFA/least privilege,
monitoring, restore evidence, end-to-end staging evidence, and five owner
sign-offs are complete.

The full repository-owned requirements are in
[Deployment](docs/DEPLOYMENT.md) and
[Operations runbook](docs/OPERATIONS_RUNBOOK.md).

## 13. Rollback

Railway can roll back an application deployment from its deployment menu.
Review the prior image and deployment variables before confirming the rollback.
See [Deployment Actions](https://docs.railway.com/deployments/deployment-actions).

Database migrations in this repository are forward-only:

- Do not delete rows from `schema_migrations`.
- Do not edit a migration already applied to a shared database.
- Roll back application code only when it is compatible with the migrated
  schema.
- For destructive database recovery, restore a verified backup into an
  isolated database and follow the approved incident plan.

## Troubleshooting

### `railway.json` appears to be ignored

That is expected for a new service after the Config as Code deprecation.
Configure the Dockerfile, start command, health path, timeout, and restart
policy manually, then inspect the deployed configuration.

### Build cannot find `package.json` or `Dockerfile`

The root directory is wrong. For the standalone AnjooraOps repository it must
be `/`, not `/web`.

### `Configuration error: ...`

Read the complete first error in the deployment log and fix that variable. Do
not copy placeholder values from `.env.example`. Core secrets must be at least
32 characters and pairwise different; production URLs must be real HTTPS
origins; the phone number must be a real 10-15 digit country-code number.

### Health check returns 503

`/api/health` could not query PostgreSQL. Check:

1. `DATABASE_URL` references `${{Postgres.DATABASE_URL}}`.
2. `DATABASE_SSL=true`.
3. `DATABASE_CA_CERT` contains the exact current `root.crt` PEM.
4. The PostgreSQL service is healthy and in the same Railway environment.
5. Startup migrations completed without an error.

### PostgreSQL reports a self-signed or unknown certificate

The CA is absent, malformed, or stale. Download the current `root.crt`, replace
the multiline `DATABASE_CA_CERT`, and redeploy. Do not disable verification.

### PostgreSQL reports a hostname mismatch

Confirm the app uses the private `Postgres.DATABASE_URL`, not a public proxy.
For an older database whose server certificate lacks its Railway private DNS
name, use Railway's supported certificate rotation/upgrade procedure or contact
Railway support. Do not bypass hostname verification.

### The public URL still uses old configuration

Variable changes are staged and require a deployment. Changes to
`NEXT_PUBLIC_APP_URL` also require a new build, so deploy the staged changes
instead of only restarting the old image.

### Scheduled messages are delayed

Confirm the one-minute external outbox trigger is active and inspect
`/api/jobs/status`. A five-minute Railway Cron schedule does not satisfy this
repository's outbox requirement.

## Official Railway references

- [Services and GitHub deployment](https://docs.railway.com/services)
- [Dockerfile builds](https://docs.railway.com/builds/dockerfiles)
- [Variables and references](https://docs.railway.com/variables)
- [PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Health checks](https://docs.railway.com/deployments/healthchecks)
- [Domains and TLS](https://docs.railway.com/networking/domains/working-with-domains)
- [Cron jobs](https://docs.railway.com/cron-jobs)
- [Railway CLI](https://docs.railway.com/cli)
- [Config as Code deprecation](https://docs.railway.com/config-as-code)
- [Deployment and rollback actions](https://docs.railway.com/deployments/deployment-actions)
