# ANJOORA WhatsApp Integration

## Customer handoff and Cloud API

After Ops persists a website consultation, it returns a `wa.me` URL for the existing handoff experience. When Meta Cloud API is configured, signed webhook events also connect inbound conversations, automated status replies, staff replies, clarification, dispatch, delivery, and refill reminders to the same customer record.

WhatsApp is the conversation channel; PostgreSQL is the system of record.

```text
WhatsApp number -> customer -> active consultation -> active order/refill
                -> exact inbound message -> durable bot job
                -> queued outbound message -> Meta status callbacks
```

## Webhook security and idempotency

Configure Meta to use:

```text
GET/POST https://YOUR_DOMAIN/api/webhooks/whatsapp
```

- GET verification checks `WHATSAPP_VERIFY_TOKEN`.
- POST bodies are limited to 1 MiB and verified with `WHATSAPP_APP_SECRET`.
- Message/status changes are processed only when `metadata.phone_number_id` matches the configured production phone-number ID.
- `meta_message_id` is unique. A replay is acknowledged but does not invoke the bot or queue another reply.
- Bot processing receives the exact stored message ID and records `QUEUED`, `PROCESSING`, `PROCESSED`, or `FAILED`.
- Meta `sent`, `delivered`, `read`, and `failed` callbacks update the exact outbound message. Terminal delivered/read states are not downgraded by older events.
- A delivery failure after API acceptance returns its outbox job to bounded retry state and remains visible in the inbox.

## Durable outbound delivery

All automated and human messages first create a `whatsapp_messages` row and a unique `message_outbox` job in the same database transaction as the workflow action. Run:

```http
POST /api/jobs/outbox?limit=100
Authorization: Bearer <CRON_SECRET>
```

at least once per minute. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, recover stale locks, use HTTP timeouts, retry with exponential backoff, and retain a `DEAD` state after the configured attempt limit.

Business state that depends on delivery is applied only after Meta accepts the message:

- a human reply clears `needs_human`;
- a clarification moves from `CLARIFICATION_PENDING` to `CLARIFICATION_REQUIRED`;
- a refill reminder records its reminder time/type/event key.

Those effects and their audits are idempotent when a delivery retry succeeds later.

## Bot routing

The deterministic bot can report consultation/order status, attach additional information, capture a clarification response, and record a refill request. Human/team requests and unclassified personal recommendation or formulation questions set `needs_human=true`; the bot does not invent a wellness recommendation.

## Proactive templates

Configure approved templates with this parameter order:

- `WHATSAPP_TEMPLATE_DISPATCH`: order ID, courier, AWB
- `WHATSAPP_TEMPLATE_DELIVERED`: order ID
- `WHATSAPP_TEMPLATE_REFILL`: source order ID, refill due date

Set `WHATSAPP_TEMPLATE_LANGUAGE` to the approved template locale. Dispatch/delivery messages fall back to queued text when a template name is absent; outside Meta's allowed conversation window that text may fail, so production should use approved templates.

## Refill scheduling

Run once daily:

```http
POST /api/jobs/refills
Authorization: Bearer <CRON_SECRET>
```

The order duration determines the refill due date. The single `REFILL_REMINDER_DAYS_BEFORE` setting determines when it becomes due soon. A stable event key and unique outbox key prevent repeat reminders for the same due date.

## Production checks

Before enabling the webhook:

1. Set all required Meta values together: verify token, app secret, permanent access token, phone-number ID, WhatsApp Business Account ID, and Graph version.
2. Verify the callback challenge and a valid signature; confirm an invalid signature returns 401.
3. Send the same inbound event twice and confirm one inbound row and one bot job.
4. Process the outbox and confirm sent/delivered/read states.
5. Test a deliberate delivery failure, retry visibility, and final `DEAD` alerting.
6. Test each approved proactive template using the production phone-number ID.
7. Monitor the schedules and thresholds in [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md).

`GO_LIVE=true` refuses incomplete Meta credentials and requires approved dispatch, delivery, and refill template names. It also rejects any populated sensitive `NEXT_PUBLIC_*` token/secret variable. Actual Business portfolio connection, webhook subscription, template approval, and phone tests must be completed in Meta and referenced in the private release evidence.
