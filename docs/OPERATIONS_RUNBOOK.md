# ANJOORA Ops Operations Runbook

This runbook covers the controls that must operate continuously after deployment. Application code supplies the protected jobs and status data; the deployment owner must connect them to a scheduler, alerting service, and managed PostgreSQL backup policy.

## Release gate

Before enabling real consultation traffic:

1. Run `npm run verify`, `npm run build`, and `npm run test:http` against an isolated release environment.
2. Set a real HTTPS `APP_URL`, independent random application secrets, `REQUIRE_STAFF_MFA=true`, and `ENABLE_DEMO_FORM=false`.
3. Choose `PAYMENT_PROVIDER=MANUAL` or configure a real HTTPS payment link and webhook-signing secret.
4. Configure either all Meta WhatsApp credentials or none. If enabled, approve and test every proactive template.
5. Provision named staff accounts with least-privilege roles. Complete password rotation and MFA enrollment before granting production access.
6. Confirm PostgreSQL TLS certificate verification, private network access, automated backups, alert destinations, and the retention settings with the privacy owner.

The production environment validator refuses partial WhatsApp configuration, placeholder secrets, insecure external payment URLs, shared core secrets, an enabled demo form, or disabled staff MFA.

## Required schedules

Call each endpoint over HTTPS with `Authorization: Bearer <CRON_SECRET>`. Store the secret in the scheduler's encrypted secret store, never in the URL or logs.

| Job | Recommended schedule | Success condition |
|---|---:|---|
| `POST /api/jobs/outbox?limit=100` | Every minute | HTTP 200; `failed` and `dead` monitored |
| `POST /api/jobs/refills` | Daily after midnight in the business timezone | HTTP 200; due count and queue count recorded |
| `POST /api/jobs/maintenance` | Daily during a low-traffic period | HTTP 200; purge counts and lifecycle-review count recorded |
| `GET /api/health` | Every minute from outside the hosting platform | HTTP 200 with `ok: true` |

The outbox worker uses row locking, bounded retries, exponential backoff, stale-lock recovery, and durable failure state. It is safe to run from more than one worker. Do not run a second ad-hoc sender outside this outbox.

## Alerting

Alert the operations owner when any of these conditions is true:

- `/api/health` fails twice consecutively.
- Any outbox job reaches `DEAD`.
- A `PENDING` or `FAILED` outbox job is more than 15 minutes old.
- A WhatsApp message is `FAILED` or `NOT_CONFIGURED` for more than 15 minutes.
- An order remains `PAYMENT_REVIEW_REQUIRED` for more than one business hour.
- The daily refill or maintenance job has no successful run in 26 hours.
- Database disk usage exceeds 75%, connection saturation exceeds 80%, or backup age exceeds 26 hours.
- `customer_records_due_for_review` returned by maintenance is non-zero.

Useful read-only checks:

```sql
SELECT status,count(*),min(created_at) oldest
FROM message_outbox
WHERE status IN ('PENDING','FAILED','DEAD')
GROUP BY status;

SELECT delivery_status,count(*),min(created_at) oldest
FROM whatsapp_messages
WHERE direction='OUTBOUND' AND delivery_status IN ('FAILED','NOT_CONFIGURED')
GROUP BY delivery_status;

SELECT count(*) payment_review_backlog
FROM orders
WHERE status='PAYMENT_REVIEW_REQUIRED';
```

## Backup and restore

Use managed PostgreSQL automated backups with point-in-time recovery where the provider supports it. A suggested starting objective is a 24-hour recovery point and four-hour recovery time, but the business owner must approve both. Retain daily backups for at least 30 days unless the approved legal/privacy policy requires a different period.

Backups are not considered working until restored. Perform a restore drill after initial deployment, after material schema changes, and at least quarterly:

1. Restore into a newly created isolated database, never over production.
2. Apply no new migrations before validating the restored snapshot.
3. Confirm `schema_migrations`, core tables, the outbox table, and `inventory_stock` are readable.
4. Compare representative row counts and open a recent consultation, order, inventory balance, and audit event.
5. Run the application against the restored database with outbound WhatsApp and payment calls disabled.
6. Record the backup timestamp, restore start/end time, verification result, operator, and deletion of the isolated database.

For the local Docker Compose deployment, the repository includes a safe isolated drill:

```powershell
npm run ops:restore-test
```

It takes a custom-format dump, creates a randomly named `anjoora_restore_test_*` database, restores and validates it, then drops only that test database. It never writes to or drops the source database.

## Retention and privacy

The daily maintenance job enforces configurable technical-data retention and respects `customers.legal_hold` for customer-linked payloads and audit events:

| Data | Default |
|---|---:|
| Consultation raw submission payload | 30 days |
| Meta WhatsApp raw payload | 30 days |
| WhatsApp message body | 365 days |
| Payment webhook/intent raw payload | 30 days |
| Rate-limit events | 2 days |
| Sent/dead outbox records | 365 days |
| Audit events | 2,555 days |
| Structured customer record review threshold | 2,555 days |

The structured-record threshold reports records due for human review; it does not silently erase commercial or consultation records. The privacy owner must approve whether those records are retained, put on legal hold, or processed through the verified anonymization workflow. Access exports omit internal token hashes, request IP hashes, raw provider payloads, and internal database identifiers.

## Incident actions

### Outbound messages are failing

1. Check Meta service health and credential expiry.
2. Inspect `message_outbox.last_error` and the matching WhatsApp message status.
3. Correct credentials/templates; leave failed jobs in place for the bounded retry worker.
4. Review `DEAD` jobs individually. Do not reset them in bulk until the cause and customer impact are known.

### Payment webhook mismatch

1. Do not manually mark paid from an unverified customer message.
2. Compare the provider dashboard with the intent public ID, amount, currency, and signed event.
3. Use the administrator manual-reconciliation action only with independently verified provider evidence.
4. Preserve the audit event and provider reference for reconciliation.

### Inventory inconsistency

1. Stop batch completion and standard-product allocation.
2. Do not edit or delete ledger rows; they are database-enforced as immutable.
3. Reconcile physical stock, then post a signed adjustment with a reference and note.
4. Review concurrent job/application logs and the related audit events before resuming.

### Suspected credential compromise

1. Rotate the affected integration, cron, payment, Meta, database, or session secret.
2. Revoke staff sessions and reset affected staff passwords; require MFA again where appropriate.
3. Review login and mutation audit events by correlation ID and time window.
4. If `SESSION_SECRET` changes, expect existing sessions and encrypted MFA secrets to become unusable; coordinate staff recovery before rotation.

## External controls still requiring an owner

The repository cannot activate provider-owned controls by itself. Before production sign-off, assign named owners for managed backup/PITR policy, alert delivery, quarterly restore evidence, Meta credentials/template approval, the live payment-provider contract/webhook format, and jurisdiction-specific retention/consent approval.
