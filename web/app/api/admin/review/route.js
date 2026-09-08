import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { queueWhatsAppText } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, hashPrivateValue } from '@/lib/http';
import { assertExpectedState, assertTransition, lockEntity } from '@/lib/transitions';

const TARGETS = Object.freeze({
  clarification: 'CLARIFICATION_PENDING',
  hold: 'ON_HOLD',
  close: 'CLOSED',
  recommend: 'READY_FOR_RECOMMENDATION',
  reopen: 'NEW',
});

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, roles: ['VAIDYA'] });
    const form = await request.formData();
    const caseId = String(form.get('case_id') || '');
    const expectedStatus = String(form.get('expected_status') || '');
    action = String(form.get('action') || '').trim().toLowerCase();
    const question = String(form.get('question') || '').trim();
    const target = TARGETS[action];
    if (!caseId) throw new HttpError(422, 'case_id is required.', 'VALIDATION_ERROR');
    if (!target) throw new HttpError(422, 'Unsupported review action.', 'UNKNOWN_ACTION');
    if (question.length > 2000) throw new HttpError(422, 'Clarification question is too long.', 'VALIDATION_ERROR');
    if (action === 'clarification' && !question) throw new HttpError(422, 'A clarification question is required.', 'VALIDATION_ERROR');

    const result = await withTransaction(async (db) => {
      const reviewCase = await lockEntity(db, 'review_cases', caseId);
      if (reviewCase.status === target && (action !== 'clarification' || reviewCase.clarification_question === question)) {
        return { consultationId: reviewCase.consultation_id, repeated: true };
      }
      assertExpectedState(reviewCase, expectedStatus);
      assertTransition('review_cases', reviewCase.status, target);
      const context = (await db.query(`
        SELECT c.urgent_safety_flag,cu.phone,wc.id conversation_id
        FROM consultations c JOIN customers cu ON cu.id=c.customer_id
        LEFT JOIN whatsapp_conversations wc ON wc.customer_id=cu.id
        WHERE c.id=$1
      `, [reviewCase.consultation_id])).rows[0];
      if (action === 'recommend' && context.urgent_safety_flag) {
        throw new HttpError(409, 'Recommendation is blocked by an urgent safety flag.', 'SAFETY_BLOCK');
      }
      if (action === 'clarification' && !context.conversation_id) {
        throw new HttpError(409, 'No WhatsApp conversation is available for clarification.', 'CONVERSATION_REQUIRED');
      }
      await db.query(`
        UPDATE review_cases SET status=$1,clarification_question=$2,assigned_to=$3,
          last_reviewed_at=now(),updated_at=now() WHERE id=$4
      `, [target, action === 'clarification' ? question : reviewCase.clarification_question, staff.id, caseId]);
      if (action === 'clarification') {
        await queueWhatsAppText({
          db, conversationId: context.conversation_id, to: context.phone,
          intent: 'CLARIFICATION_REQUEST',
          dedupeKey: `review:${caseId}:clarification:${hashPrivateValue(question).slice(0, 24)}`,
          body: `Our Vaidya would like to clarify one point before preparing your recommendation:\n\n${question}\n\nYou can reply directly to this message.`,
          onSent: { type: 'CLARIFICATION_SENT', reviewCaseId: caseId },
        });
      }
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'REVIEW_CASE', entityId: caseId,
        action: action.toUpperCase(), priorState: reviewCase.status, resultingState: target,
        payload: action === 'clarification' ? { question } : {},
      });
      return { consultationId: reviewCase.consultation_id, repeated: false };
    });
    return NextResponse.redirect(new URL(`/admin/consultations/${result.consultationId}`, request.url), 303);
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'REVIEW_CASE', action,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    return errorResponse(error);
  }
}
