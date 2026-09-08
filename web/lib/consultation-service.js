import { withTransaction } from '@/lib/db';
import { uuid, publicId, withPublicIdRetry } from '@/lib/ids';
import { buildFolio, buildWhatsAppHandoff } from '@/lib/folio';
import { CONSENT_TEXT, CONSENT_VERSION } from '@/lib/consultation-input';
import { writeAudit } from '@/lib/audit';
import { normalizePhone } from '@/lib/phone';

function publicResponse({ customer, consultation, reviewCase, conversation, context, folioText }) {
  const handoff = buildWhatsAppHandoff({
    folioId: consultation.folio_id,
    name: customer.name,
    concern: context.primaryConcern.label,
    concerns: context.concerns,
    safetyReviewRequired: context.safety.reviewRequired,
    urgentSafetyFlag: context.safety.urgent,
    folioText,
  });
  const destination = normalizePhone(process.env.ANJOORA_WHATSAPP_NUMBER || '');
  const whatsappUrl = destination ? `https://wa.me/${destination}?text=${encodeURIComponent(handoff)}` : null;
  return {
    ok: true,
    customer_id: customer.public_id,
    consultation_id: consultation.public_id,
    folio_id: consultation.folio_id,
    case_id: reviewCase.public_id,
    conversation_id: conversation.public_id,
    concerns: context.concerns.map((item) => ({
      id: item.key,
      label: item.label,
      is_primary: item.isPrimary,
      position: item.position,
    })),
    safety: {
      outcome: context.safety.outcome,
      review_required: context.safety.reviewRequired,
      urgent: context.safety.urgent,
      flags: context.safety.flags.map((flag) => flag.code),
    },
    consent_version: CONSENT_VERSION,
    folio_text: folioText,
    whatsapp_url: whatsappUrl,
  };
}

export async function submitConsultation({ input, normalized, request, sourceIpHash, correlation }) {
  return withPublicIdRetry(() => withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [normalized.submissionId]);
    const replay = await db.query(`
      SELECT submission_response
      FROM consultations
      WHERE submission_id=$1
      LIMIT 1
    `, [normalized.submissionId]);
    if (replay.rows[0]?.submission_response) {
      return { response: replay.rows[0].submission_response, replayed: true };
    }

    const customerInsert = await db.query(`
      INSERT INTO customers (id, public_id, name, phone, city, language, best_contact_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (phone) DO NOTHING
      RETURNING id, public_id, name, phone
    `, [
      uuid(), publicId('ANJ-C'), normalized.name, normalized.phone, normalized.city,
      normalized.language, normalized.bestContactTime,
    ]);
    const customer = customerInsert.rows[0] || (await db.query(`
      SELECT id, public_id, name, phone FROM customers WHERE phone=$1 LIMIT 1
    `, [normalized.phone])).rows[0];

    const consultation = {
      id: uuid(),
      public_id: publicId('ANJ-CON'),
      folio_id: publicId('ANJ-FOL'),
    };
    const reviewCase = { id: uuid(), public_id: publicId('ANJ-CASE') };
    const safePayload = {
      ...input,
      name: normalized.name,
      whatsapp: normalized.phone,
      consent_text: undefined,
      anti_bot_token: undefined,
      consent_version: CONSENT_VERSION,
    };
    const folioText = buildFolio({
      name: normalized.name,
      whatsapp: normalized.phone,
      city: normalized.city,
      language: normalized.language,
      best_time_to_message: normalized.bestContactTime,
      concern: normalized.context.primaryConcern.label,
      primary_concern: normalized.context.primaryConcern.label,
      concerns: normalized.context.concerns,
      main_goal: normalized.mainGoal,
      duration: normalized.duration,
      daily_effect: normalized.dailyEffect,
      appetite_digestion: normalized.appetiteDigestion,
      body_climate: normalized.bodyClimate,
      energy_pattern: normalized.energyPattern,
      meal_rhythm: normalized.mealRhythm,
      sleep_rhythm: normalized.sleepRhythm,
      realistic_rituals: normalized.realisticRituals,
      stress_response: normalized.stressResponse,
      emotional_support: normalized.emotionalSupport,
      change_style: normalized.changeStyle,
      preferred_format: normalized.preferredFormat,
      safety_flags: normalized.context.safety.flags,
      safety_review_required: normalized.context.safety.reviewRequired,
      urgent_safety_flag: normalized.context.safety.urgent,
      safety_screen_version: normalized.safetyScreenVersion,
      consent_text: CONSENT_TEXT,
    });

    await db.query(`
      INSERT INTO consultations (
        id, public_id, folio_id, customer_id, concern, main_goal, duration, daily_effect,
        appetite_digestion, body_climate, energy_pattern, meal_rhythm, sleep_rhythm,
        realistic_rituals, stress_response, emotional_support, change_style, preferred_format,
        questionnaire_version, raw_payload, consent_text, consent_at, folio_text, status,
        safety_review_required, urgent_safety_flag, safety_screen_version,
        submission_id, consent_version, source_ip_hash
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,
        $20::jsonb,$21,now(),$22,'SUBMITTED',$23,$24,$25,$26,$27,$28
      )
    `, [
      consultation.id, consultation.public_id, consultation.folio_id, customer.id,
      normalized.context.primaryConcern.label, normalized.mainGoal, normalized.duration,
      normalized.dailyEffect, normalized.appetiteDigestion, normalized.bodyClimate,
      normalized.energyPattern, normalized.mealRhythm, normalized.sleepRhythm,
      JSON.stringify(normalized.realisticRituals), normalized.stressResponse,
      normalized.emotionalSupport, normalized.changeStyle, normalized.preferredFormat,
      normalized.questionnaireVersion, JSON.stringify(safePayload), CONSENT_TEXT, folioText,
      normalized.context.safety.reviewRequired, normalized.context.safety.urgent,
      normalized.safetyScreenVersion, normalized.submissionId, CONSENT_VERSION, sourceIpHash,
    ]);

    for (const item of normalized.context.concerns) {
      await db.query(`
        INSERT INTO consultation_concerns(consultation_id,concern_key,concern_label,is_primary,position)
        VALUES($1,$2,$3,$4,$5)
      `, [consultation.id, item.key, item.label, item.isPrimary, item.position]);
    }
    for (const flag of normalized.context.safety.flags) {
      await db.query(`
        INSERT INTO consultation_safety_flags(consultation_id,flag_code,flag_label,severity,position)
        VALUES($1,$2,$3,$4,$5)
      `, [consultation.id, flag.code, flag.label, flag.severity, flag.position]);
    }

    await db.query(`
      INSERT INTO review_cases(id,public_id,consultation_id,status)
      VALUES($1,$2,$3,'NEW')
    `, [reviewCase.id, reviewCase.public_id, consultation.id]);

    const existingConversation = await db.query(`
      SELECT id, public_id FROM whatsapp_conversations WHERE customer_id=$1 LIMIT 1
    `, [customer.id]);
    let conversation = existingConversation.rows[0];
    if (conversation) {
      await db.query(`
        UPDATE whatsapp_conversations
        SET active_consultation_id=$1, updated_at=now()
        WHERE id=$2
      `, [consultation.id, conversation.id]);
    } else {
      conversation = { id: uuid(), public_id: publicId('ANJ-WA') };
      await db.query(`
        INSERT INTO whatsapp_conversations(id,public_id,customer_id,active_consultation_id)
        VALUES($1,$2,$3,$4)
      `, [conversation.id, conversation.public_id, customer.id, consultation.id]);
    }

    const response = publicResponse({
      customer,
      consultation,
      reviewCase,
      conversation,
      context: normalized.context,
      folioText,
    });
    await db.query(`UPDATE consultations SET submission_response=$1::jsonb WHERE id=$2`, [JSON.stringify(response), consultation.id]);
    await writeAudit(db, {
      request,
      entityType: 'CONSULTATION',
      entityId: consultation.id,
      action: 'SUBMITTED',
      priorState: null,
      resultingState: 'SUBMITTED',
      correlation,
      payload: {
        folio_id: consultation.folio_id,
        source: 'anjoora-server',
        concerns: normalized.context.concerns.map((item) => ({ key: item.key, primary: item.isPrimary, position: item.position })),
        safety_outcome: normalized.context.safety.outcome,
        consent_version: CONSENT_VERSION,
      },
    });

    return { response, replayed: false };
  }));
}
