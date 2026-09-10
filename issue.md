# AnjooraOps Open Issues

**Updated:** 10 September 2026
**Scope:** Unresolved production launch actions only.

Completed repository implementation and verification tasks have been removed from this file. There are currently **no known repository-owned P0 or P1 defects**. Launch remains **NO-GO** until the eight external gates below have real, dated evidence; local/demo values must not be used to close them.

## Remaining gates

| ID | Priority | Remaining external outcome | Owner |
|---|---:|---|---|
| LIVE-001 | P0 | Named production staff, rotated passwords, and approved least privilege | Operations administrator |
| LIVE-002 | P0 | Production secrets, URLs, and certificate-verified PostgreSQL | Deployment owner |
| LIVE-003 | P0 | Verified Meta WhatsApp account, webhook, templates, and live scenario evidence | Messaging owner |
| LIVE-004 | P0 | Production schedules, alerts, on-call ownership, and incident drill | Operations/DevOps |
| LIVE-005 | P0 | Selected payment provider and completed sandbox/live certification | Payments owner |
| LIVE-006 | P1 | Managed backups, PITR, alerts, and evidenced restore rehearsal | Database/DevOps owner |
| LIVE-007 | P1 | Approved privacy/consent/retention procedure and scenario evidence | Privacy/legal owner |
| LIVE-008 | P1 | Production-like staging release, end-to-end evidence, and five owner sign-offs | Release owner |

## LIVE-001 — Activate production staff accounts

- [ ] Approve the exact production staff register with one named email and smallest suitable role (`ADMIN`, `VAIDYA`, `OPERATIONS`, or `SUPPORT`) per person.
- [ ] Remove bootstrap credentials from the live runtime, rotate any initially provisioned administrator password, and deactivate test, departed, or unused accounts.
- [ ] Verify that every active user has changed the temporary password.
- [ ] Verify least privilege with the real accounts; `SUPPORT` must have only Dashboard and WhatsApp operational access.
- [ ] Run `STAFF_ACTION=audit STAFF_REGISTER_FILE=... npm run staff:manage` against the production database and retain the passing output.

Administrators create and maintain named accounts at `/admin/staff`. The production names, emails, roles, and approval register are required from the operations owner. AnjooraOps uses the named work email as the username, together with the user's password.

## LIVE-002 — Configure production secrets and database TLS

- [ ] Generate independent high-entropy production secrets and store them only in the approved deployment secret store.
- [ ] Configure the real HTTPS application URLs and managed PostgreSQL URL; install the provider CA where required and enable full certificate verification.
- [ ] Configure the same server-only integration secret in Anjoora and AnjooraOps without exposing it through `NEXT_PUBLIC_*` or browser code.
- [ ] Run `GO_LIVE=true npm run config:validate` in the production environment and retain the passing output.

Required input: the deployment target, secret store, domains, managed database credentials, and trusted CA details.

## LIVE-003 — Activate Meta WhatsApp

- [ ] Connect the verified Meta Business portfolio and WhatsApp Business Account, then configure the real WABA/phone IDs, Graph version, access token, verify token, and app secret.
- [ ] Register the public HTTPS webhook and subscribe it to message and delivery-status events.
- [ ] Obtain approval for the configured dispatch, delivered, and refill templates.
- [ ] Record real-provider tests for inbound messages, duplicate delivery, human handoff, outbound messages, and sent/delivered/read/failed callbacks.
- [ ] Decide whether to requeue the three preserved local `NOT_CONFIGURED` messages after Meta activation or record owner acknowledgement that they are non-deliverable local test history. Do not mark them delivered without provider evidence.

See [WhatsApp integration](docs/WHATSAPP.md).

## LIVE-004 — Schedule production jobs and connect alerts

- [ ] Schedule outbox processing at least once per minute and refill/maintenance processing daily, all authenticated with the production `CRON_SECRET`.
- [ ] Connect alerts for overdue/stalled jobs, delayed/dead messages, callback failures, payment review, low stock, database errors/capacity, and backup failures.
- [ ] Assign the on-call owner and escalation route for every alert.
- [ ] Record one received test alert and one incident drill, then confirm `npm run ops:status` is healthy in the release environment.

Required input: the production scheduler, monitoring/alerting platform, and on-call contacts.

## LIVE-005 — Certify the payment provider

- [ ] Select the actual production provider and configure its secure checkout URL and independent webhook secret.
- [ ] Review/version the native adapter, signature verification, and exact paid/failed/cancelled/refunded event mapping.
- [ ] Record provider-sandbox tests for success, failure, cancellation, full/partial refund, duplicate/delayed events, amount/reference mismatch, and the unpaid-fulfilment block.
- [ ] Complete a reconciliation test, name who may reconcile manually, and obtain payments-owner approval.

Required input: the chosen provider, sandbox/production account, native webhook specification, and reconciliation owner.

## LIVE-006 — Enable managed backup and recovery

- [ ] Enable encrypted automatic backups and point-in-time recovery, and obtain approval for the RPO and RTO.
- [ ] Restrict/audit backup access and configure backup-age/failure alerts.
- [ ] Restore a production-like backup into an isolated managed database.
- [ ] Run `npm run ops:restore-validate`, record duration and evidence, review the result, and set the next drill date.

Required input: the managed database/backup provider, approved RPO/RTO, infrastructure owner, and isolated restore target.

## LIVE-007 — Obtain privacy and legal approval

- [ ] Approve the exact customer consent text/version and all retention periods.
- [ ] Approve the identity-verification method plus access, correction, anonymization, and legal-hold procedures.
- [ ] Name the people permitted to approve and complete privacy requests.
- [ ] Test one non-production request of each type and retain privacy/legal-owner evidence.

Required input: the approved policy text, approval reference/date, retention decisions, authorized people, and legal/privacy sign-off.

## LIVE-008 — Complete the final release gate

- [ ] Deploy an immutable release candidate to a production-like staging environment.
- [ ] Run the builds, `npm run verify`, HTTP smoke, payment HTTP suite, and provider-managed backup/restore validation against that release.
- [ ] Record a complete customer journey from consultation through review, recommendation, acceptance, payment, fulfilment, dispatch, delivery, and refill.
- [ ] Test every real staff role and all provider failure/replay paths in staging.
- [ ] Confirm monitoring, alerts, backup, privacy procedure, support contacts, incident response, and rollback steps.
- [ ] Obtain dated release, business, clinical, privacy, and infrastructure owner sign-offs.
- [ ] Run `GO_LIVE=true STAFF_REGISTER_FILE=... RELEASE_EVIDENCE_FILE=... npm run release:audit`; launch only when it passes with no findings.

Use [staff-register.example.json](docs/staff-register.example.json) and [release-evidence.example.json](docs/release-evidence.example.json) as schemas, but store completed evidence in the approved private location. The complete operating procedure is in the [Operations runbook](docs/OPERATIONS_RUNBOOK.md).
