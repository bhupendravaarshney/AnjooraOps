import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { queueWhatsAppText } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';

export async function POST(request) {
  let staff = null;
  try {
    staff = await requireStaff({ request, capability: 'WHATSAPP' });
    const form = await request.formData();
    const conversationId = String(form.get('conversation_id') || '');
    const messageKey = String(form.get('message_key') || '');
    const body = String(form.get('body') || '').trim();
    if (!conversationId || !/^[0-9a-f-]{36}$/i.test(messageKey) || !body) {
      throw new HttpError(422, 'Conversation, message key, and body are required.', 'VALIDATION_ERROR');
    }
    if (body.length > 4096) throw new HttpError(422, 'Message is too long.', 'VALIDATION_ERROR');
    await withTransaction(async (db) => {
      const conversation = (await db.query(`
        SELECT wc.*,c.phone FROM whatsapp_conversations wc
        JOIN customers c ON c.id=wc.customer_id WHERE wc.id=$1 FOR UPDATE OF wc
      `, [conversationId])).rows[0];
      if (!conversation) throw new HttpError(404, 'Conversation not found.', 'NOT_FOUND');
      const queued = await queueWhatsAppText({
        db, conversationId, to: conversation.phone, body, intent: 'HUMAN_AGENT',
        dedupeKey: `human:${messageKey}`,
        onSent: { type: 'HUMAN_REPLY_SENT', staffId: staff.id, conversationId },
      });
      await db.query(`UPDATE whatsapp_conversations SET status='HUMAN_SUPPORT',assigned_to=$1,updated_at=now() WHERE id=$2`, [staff.id, conversationId]);
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'WHATSAPP_CONVERSATION', entityId: conversationId,
        action: 'HUMAN_REPLY_QUEUED', priorState: conversation.status, resultingState: 'HUMAN_SUPPORT',
        payload: { message_id: queued.messageId, delivery_status: queued.deliveryStatus },
      });
    });
    return sameOriginRedirect(`/admin/whatsapp?conversation=${encodeURIComponent(conversationId)}`);
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'WHATSAPP_CONVERSATION', action: 'HUMAN_REPLY',
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    return errorResponse(error);
  }
}
