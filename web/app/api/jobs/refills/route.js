import { query, withTransaction } from '@/lib/db';
import { refreshRefillStatuses } from '@/lib/refills';
import { queueWhatsAppTemplate } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { cronAuthorized, runOperationalJob } from '@/lib/jobs';

export async function POST(request) {
  if (!cronAuthorized(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const result = await runOperationalJob('refills', async () => {
      await refreshRefillStatuses();
      const { rows } = await query(`
    SELECT r.id,r.public_id,r.due_date,r.status,c.phone,wc.id conversation_id,o.public_id order_public_id
    FROM refills r JOIN customers c ON c.id=r.customer_id
    JOIN orders o ON o.id=r.source_order_id
    LEFT JOIN whatsapp_conversations wc ON wc.customer_id=c.id
    WHERE r.status IN ('DUE','DUE_SOON') AND r.decision IS NULL
    ORDER BY r.due_date,r.id LIMIT 200
      `);
      let queued = 0;
      let skipped = 0;
      const templateName = process.env.WHATSAPP_TEMPLATE_REFILL || null;
      for (const candidate of rows) {
        if (!candidate.conversation_id || !templateName) { skipped += 1; continue; }
        const message = await withTransaction(async (db) => {
          const refill = (await db.query(`SELECT * FROM refills WHERE id=$1 FOR UPDATE`, [candidate.id])).rows[0];
          if (!refill || refill.decision || !['DUE', 'DUE_SOON'].includes(refill.status)) return null;
          const eventKey = `refill:${refill.id}:${String(refill.due_date).slice(0, 10)}:reminder`;
          if (refill.reminder_event_key === eventKey) return null;
          const queuedMessage = await queueWhatsAppTemplate({
            db, conversationId: candidate.conversation_id, to: candidate.phone, templateName,
            parameters: [candidate.order_public_id, String(candidate.due_date).slice(0, 10)],
            intent: 'REFILL_REMINDER', dedupeKey: eventKey,
            onSent: { type: 'REFILL_REMINDER_SENT', refillId: refill.id, reminderType: refill.status, eventKey },
          });
          await writeAudit(db, {
            request, entityType: 'REFILL', entityId: refill.id, action: 'REMINDER_QUEUED',
            priorState: refill.status, resultingState: refill.status,
            payload: { event_key: eventKey, message_id: queuedMessage.messageId },
          });
          return queuedMessage;
        });
        if (message?.queued) queued += 1;
        else skipped += 1;
      }
      return { due: rows.length, queued, skipped, templateConfigured: Boolean(templateName) };
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error('Refill job failed', error);
    return Response.json({ ok: false, error: 'Refill job failed.' }, { status: 500 });
  }
}
