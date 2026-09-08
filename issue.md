# AnjooraOps Open Issues

**Updated:** 8 September 2026  
**Scope:** Tasks that are still open before production launch.

All completed application findings have been removed from this file. The items below require real production accounts, credentials, providers, infrastructure, or business approval. They are not safe to mark complete using local test values.

## Summary

| ID | Priority | Open item | Owner | Status |
|---|---:|---|---|---|
| LIVE-001 | P0 | Production staff accounts, password rotation, and MFA | Operations administrator | Open |
| LIVE-002 | P0 | Production secrets and verified database TLS | Deployment owner | Open |
| LIVE-003 | P0 | Meta WhatsApp production activation | Messaging owner | Open |
| LIVE-004 | P0 | Scheduled jobs and operational alerts | Operations/DevOps | Open |
| LIVE-005 | P0 | Live payment-provider certification | Payments owner | Open |
| LIVE-006 | P1 | Managed backups, PITR, and restore rehearsal | Database/DevOps owner | Open |
| LIVE-007 | P1 | Privacy, consent, retention, and legal approval | Privacy/legal owner | Open |
| LIVE-008 | P1 | Final staging release gate and sign-off | Release owner | Open |

---

## LIVE-001: Activate secure production staff accounts

**Risk if skipped:** Shared or bootstrap credentials could give the wrong person access to customer, health-context, payment, or inventory data.

- [ ] Rotate the existing bootstrap/local administrator password.
- [ ] Create a named account for every staff member; do not share accounts.
- [ ] Assign the smallest suitable role: `ADMIN`, `VAIDYA`, `OPERATIONS`, or `SUPPORT`.
- [ ] Require and verify authenticator MFA for every production account.
- [ ] Deactivate test, departed, and unused accounts.
- [ ] Confirm that staff can see only the screens and actions required by their role.

**Complete when:** The production staff register is approved and every active user has a unique rotated password, MFA, and verified least-privilege role.

## LIVE-002: Configure production secrets and database TLS

**Risk if skipped:** Development credentials or an unverified database connection could expose the application and its data.

- [ ] Generate unique high-entropy production values for every secret in `.env.example`.
- [ ] Keep secrets only in the approved deployment secret store.
- [ ] Configure the production application URLs and database URL.
- [ ] Install/configure the trusted database CA and enable certificate verification.
- [ ] Confirm that Anjoora and AnjooraOps use the same server-only integration secret.
- [ ] Run production environment validation and confirm that no placeholder value remains.

**Complete when:** Production validation passes and the database connection uses a verified certificate.

## LIVE-003: Activate Meta WhatsApp

**Risk if skipped:** Customer handoff, clarification, order, dispatch, and refill messages may not be sent or tracked.

- [ ] Connect the verified Meta Business portfolio and WhatsApp Business Account.
- [ ] Configure the real phone-number ID, account ID, server-side access token, verify token, and app secret.
- [ ] Register the public HTTPS webhook and subscribe to message/status events.
- [ ] Approve and configure all required business-initiated message templates.
- [ ] Test inbound messages, duplicate delivery, human handoff, outbound messages, and sent/delivered/read/failed callbacks.
- [ ] Confirm that no Meta token is present in browser code or a `NEXT_PUBLIC_*` variable.

**Complete when:** All WhatsApp staging scenarios pass using the real sandbox/production configuration and the messaging owner signs off.

See [WhatsApp integration](docs/WHATSAPP.md).

## LIVE-004: Schedule jobs and connect alerts

**Risk if skipped:** Messages can remain queued, refill reminders can be late, and expired/sensitive operational data may not be cleaned up.

- [ ] Schedule the outbox job at least once per minute.
- [ ] Schedule refill and maintenance jobs daily.
- [ ] Protect every job call with the production `JOB_SECRET`.
- [ ] Alert on delayed/dead outbox work, failed callbacks, overdue jobs, low stock, database errors, and backup failures.
- [ ] Define an on-call owner and escalation route for every alert.
- [ ] Record one successful test alert and one incident drill.

**Complete when:** Schedules run reliably in production and test alerts reach the named responders.

## LIVE-005: Certify the live payment provider

**Risk if skipped:** Payment state may not match the provider, which can lead to unpaid fulfilment or incorrect customer/order status.

- [ ] Select the production payment provider and configure its secure payment URL and webhook secret.
- [ ] Map paid, failed, cancelled, and refunded events to the provider's actual event names.
- [ ] Verify webhook signatures and replay/idempotency behavior.
- [ ] Test successful payment, failure, cancellation, refund, duplicate event, delayed event, and amount mismatch.
- [ ] Test daily reconciliation and define who may use manual reconciliation.
- [ ] Confirm that an unpaid order cannot enter stock allocation or production.

**Complete when:** Provider sandbox certification and reconciliation tests pass and the payments owner signs off.

## LIVE-006: Enable managed backup and recovery

**Risk if skipped:** A database or deployment failure could cause unacceptable data loss or downtime.

- [ ] Enable encrypted automatic backups and point-in-time recovery (PITR).
- [ ] Set and approve the recovery point objective (RPO) and recovery time objective (RTO).
- [ ] Restrict and audit backup access.
- [ ] Configure backup-age and backup-failure alerts.
- [ ] Restore a production-like backup into an isolated environment.
- [ ] Record restore duration, validation evidence, owner, date, and next drill date.

**Complete when:** A production-like restore meets the approved RPO/RTO and the evidence is reviewed.

## LIVE-007: Obtain privacy and legal approval

**Risk if skipped:** Consent, retention, export, correction, anonymization, or legal-hold handling may not meet the applicable policy or law.

- [ ] Approve the customer consent text and version.
- [ ] Approve retention periods for consultations, messages, raw provider payloads, payments, audits, and customer records.
- [ ] Approve the identity-verification method for privacy requests.
- [ ] Approve access export, correction, anonymization, and legal-hold procedures.
- [ ] Name the people permitted to approve and complete privacy requests.
- [ ] Test one non-production request of each type and retain the evidence.

**Complete when:** The privacy/legal owner signs the policy and test procedure used by operations.

## LIVE-008: Complete the final release gate

**Risk if skipped:** A locally working build may still fail with production domains, providers, permissions, schedules, or infrastructure.

- [ ] Deploy the release candidate to a production-like staging environment.
- [ ] Run the automated verification, builds, HTTP smoke suite, and backup/restore test.
- [ ] Complete an end-to-end customer journey: consultation, safety review, clarification, recommendation, acceptance, payment, fulfilment, dispatch, delivery, and refill.
- [ ] Test each staff role and confirm forbidden actions are blocked.
- [ ] Test WhatsApp and payment-provider failure/replay cases.
- [ ] Confirm monitoring, alerts, backups, privacy procedure, support contacts, and rollback steps.
- [ ] Record release-owner, business-owner, clinical-owner, privacy-owner, and infrastructure-owner sign-off.

**Complete when:** Every release-gate item in the [Operations runbook](docs/OPERATIONS_RUNBOOK.md) has dated evidence and approval.

## User guidance

The plain-language guide for customers and staff is available in the [English and Hindi user handbook](docs/USER_HANDBOOK.md).

