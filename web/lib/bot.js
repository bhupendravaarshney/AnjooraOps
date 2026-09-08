import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { queueWhatsAppText } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';

function lc(value) { return String(value || '').toLowerCase(); }

export function detectIntent(text, context = {}) {
  const value = lc(text);
  if (/human|person|team|vaidya|doctor|call me|speak|talk to/.test(value)) return 'HUMAN_SUPPORT';
  if (/refill|reorder|same product|same formula|finish|finishing|repeat/.test(value)) return 'REFILL';
  if (/order|dispatch|tracking|track|courier|awb|delivered|delivery/.test(value)) return 'ORDER_STATUS';
  if (/status|reviewed|review|folio|consultation/.test(value)) return 'CONSULTATION_STATUS';
  if (/forgot|add information|add info|also|mention|one more/.test(value)) return 'ADD_INFO';
  if (context.reviewStatus === 'CLARIFICATION_REQUIRED' || context.reviewStatus === 'WAITING_FOR_CUSTOMER') return 'CLARIFICATION_REPLY';
  return 'OTHER';
}

async function activeContext(db, customerId) {
  const { rows } = await db.query(`
    SELECT wc.id conversation_id,wc.active_consultation_id,wc.active_order_id,
           c.public_id consultation_public_id,c.folio_id,c.status consultation_status,
           rc.status review_status,o.public_id order_public_id,o.status order_status,
           d.status dispatch_status,d.courier,d.awb
    FROM whatsapp_conversations wc
    LEFT JOIN consultations c ON c.id=wc.active_consultation_id
    LEFT JOIN review_cases rc ON rc.consultation_id=c.id
    LEFT JOIN orders o ON o.id=wc.active_order_id
    LEFT JOIN dispatches d ON d.order_id=o.id
    WHERE wc.customer_id=$1
    LIMIT 1
  `, [customerId]);
  return rows[0] || null;
}

export async function handleInbound({ messageId, customer, conversation, text }) {
  try {
    return await withTransaction(async (db) => {
      const inbound = (await db.query(`SELECT * FROM whatsapp_messages WHERE id=$1 FOR UPDATE`, [messageId])).rows[0];
      if (!inbound) throw new Error('Inbound message not found.');
      if (inbound.processed_at || inbound.processing_status === 'PROCESSED') return { duplicate: true };
      await db.query(`UPDATE whatsapp_messages SET processing_status='PROCESSING',processing_attempts=processing_attempts+1,last_error=NULL,updated_at=now() WHERE id=$1`, [messageId]);

      const context = await activeContext(db, customer.id);
      const intent = detectIntent(text, { reviewStatus: context?.review_status });
      await db.query(`UPDATE whatsapp_messages SET intent=$1 WHERE id=$2`, [intent, messageId]);

      const reply = async (body, replyIntent = intent) => {
        await queueWhatsAppText({
          db,
          conversationId: conversation.id,
          to: customer.phone,
          intent: replyIntent,
          body,
          dedupeKey: `inbound:${messageId}:reply`,
        });
      };

      if (intent === 'HUMAN_SUPPORT') {
        await db.query(`UPDATE whatsapp_conversations SET status='HUMAN_SUPPORT',needs_human=true,updated_at=now() WHERE id=$1`, [conversation.id]);
        await reply('I have passed this conversation to the ANJOORA team. A team member can continue from the same customer record.');
      } else if (intent === 'CONSULTATION_STATUS') {
        const body = context?.folio_id
          ? `Your consultation ${context.folio_id} is currently: ${(context.review_status || context.consultation_status || 'SUBMITTED').replaceAll('_', ' ')}.`
          : 'I could not find an active consultation on this WhatsApp number. Please submit the ANJOORA consultation first.';
        await reply(body);
      } else if (intent === 'ORDER_STATUS') {
        let body = 'I could not find an active order on this WhatsApp number.';
        if (context?.order_public_id) {
          body = `Order ${context.order_public_id} is currently: ${(context.dispatch_status || context.order_status || 'AWAITING_ACCEPTANCE').replaceAll('_', ' ')}.`;
          if (context.awb) body += ` Tracking/AWB: ${context.awb}${context.courier ? ` (${context.courier})` : ''}.`;
        }
        await reply(body);
      } else if (intent === 'ADD_INFO' || intent === 'CLARIFICATION_REPLY') {
        if (context?.active_consultation_id) {
          await db.query(`
            INSERT INTO consultation_notes(id,consultation_id,author_type,author_ref,note_type,body)
            VALUES($1,$2,'CUSTOMER',$3,$4,$5)
          `, [uuid(), context.active_consultation_id, customer.phone, intent, text]);
          if (intent === 'CLARIFICATION_REPLY') {
            await db.query(`UPDATE review_cases SET status='NEW',updated_at=now() WHERE consultation_id=$1 AND status='CLARIFICATION_REQUIRED'`, [context.active_consultation_id]);
          }
          await reply(intent === 'CLARIFICATION_REPLY'
            ? 'Thank you. Your reply has been added to the consultation and returned to the Vaidya review queue.'
            : 'Thank you. I have added this information to your active consultation for the Vaidya to review.');
        } else {
          await db.query(`UPDATE whatsapp_conversations SET status='HUMAN_SUPPORT',needs_human=true,updated_at=now() WHERE id=$1`, [conversation.id]);
          await reply('I could not find an active consultation. I have passed your message to the ANJOORA team.', 'HUMAN_REVIEW');
        }
      } else if (intent === 'REFILL') {
        const refill = (await db.query(`
          SELECT r.id,r.public_id,r.status,r.due_date,o.public_id order_public_id
          FROM refills r JOIN orders o ON o.id=r.source_order_id
          WHERE r.customer_id=$1 ORDER BY r.due_date DESC LIMIT 1
          FOR UPDATE OF r
        `, [customer.id])).rows[0];
        if (refill && !['ORDERED', 'CLOSED'].includes(refill.status)) {
          await db.query(`UPDATE refills SET status='REVIEW_PENDING',decision='CUSTOMER_REQUESTED',updated_at=now() WHERE id=$1`, [refill.id]);
          await reply(`Your refill request ${refill.public_id} has been recorded and linked to order ${refill.order_public_id}. The ANJOORA team will review whether the same plan can continue or needs modification.`);
        } else {
          await db.query(`UPDATE whatsapp_conversations SET status='HUMAN_SUPPORT',needs_human=true,updated_at=now() WHERE id=$1`, [conversation.id]);
          await reply('I could not find an open refill request. I have marked this conversation for the ANJOORA team to review.', 'HUMAN_REVIEW');
        }
      } else {
        await db.query(`UPDATE whatsapp_conversations SET status='HUMAN_SUPPORT',needs_human=true,updated_at=now() WHERE id=$1`, [conversation.id]);
        await reply('I have added your message to the ANJOORA conversation and passed it to the team. Personal recommendation or formulation questions are reviewed by a human Vaidya.', 'HUMAN_REVIEW');
      }

      await db.query(`UPDATE whatsapp_messages SET processing_status='PROCESSED',processed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`, [messageId]);
      await writeAudit(db, {
        entityType: 'WHATSAPP_MESSAGE', entityId: messageId, action: 'BOT_PROCESSED',
        priorState: 'QUEUED', resultingState: 'PROCESSED', payload: { intent },
      });
      return { duplicate: false, intent };
    });
  } catch (error) {
    await query(`UPDATE whatsapp_messages SET processing_status='FAILED',last_error=$1,updated_at=now() WHERE id=$2`, [String(error.message).slice(0, 1000), messageId]).catch(() => {});
    throw error;
  }
}

export async function ensureConversation(customerId, activeConsultationId = null, db = null) {
  const client = db || { query };
  const id = uuid();
  const publicIdentifier = publicId('ANJ-WA');
  const { rows } = await client.query(`
    INSERT INTO whatsapp_conversations(id,public_id,customer_id,active_consultation_id)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(customer_id) DO UPDATE SET
      active_consultation_id=COALESCE(EXCLUDED.active_consultation_id,whatsapp_conversations.active_consultation_id),
      updated_at=now()
    RETURNING *
  `, [id, publicIdentifier, customerId, activeConsultationId]);
  return rows[0];
}
