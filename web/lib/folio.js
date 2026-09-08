function line(label, value) {
  return value ? `* ${label}: ${value}` : null;
}

function concernContext(input) {
  const submitted = Array.isArray(input.concerns) ? input.concerns : [];
  const concerns = submitted
    .map((item) => typeof item === 'string' ? { label: item, isPrimary: false } : item)
    .filter((item) => item?.label);
  const primaryLabel = input.primary_concern
    || concerns.find((item) => item.isPrimary)?.label
    || input.concern
    || concerns[0]?.label;
  const linked = concerns
    .filter((item) => item.label !== primaryLabel)
    .map((item) => item.label);

  return { primaryLabel, linked };
}

function safetyContext(input) {
  const submitted = Array.isArray(input.safety_flags) ? input.safety_flags : [];
  const flags = submitted
    .map((item) => typeof item === 'string' ? item : item?.label)
    .filter(Boolean);
  return {
    flags,
    reviewRequired: input.safety_review_required === true,
    urgent: input.urgent_safety_flag === true,
  };
}

export function buildFolio(input) {
  const rituals = Array.isArray(input.realistic_rituals) ? input.realistic_rituals.join(', ') : input.realistic_rituals;
  const consent = input.consent_text || 'I consent to ANJOORA using these details to contact me on WhatsApp for review, recommendations and payment communication. I understand that this message does not place an order or make a payment.';
  const concerns = concernContext(input);
  const safety = safetyContext(input);

  return [
    'ANJOORA · PERSONAL CONSULTATION FOLIO',
    'For human Vaidya review',
    safety.urgent ? 'URGENT SAFETY FLAG · DO NOT PREPARE A WELLNESS RECOMMENDATION' : null,
    '',
    'Hello ANJOORA, I have completed my consultation and would like my folio to be reviewed.',
    '',
    'PERSONAL DETAILS',
    line('Name', input.name),
    line('WhatsApp', input.whatsapp),
    line('City', input.city),
    line('Language', input.language),
    line('Best time to message', input.best_time_to_message),
    '',
    'WHAT MATTERS NOW',
    line('Primary concern', concerns.primaryLabel),
    line('Linked concerns', concerns.linked.join(', ')),
    line('Main goal', input.main_goal),
    line('Duration', input.duration),
    line('Daily effect', input.daily_effect),
    '',
    'BODY & DAILY RHYTHM',
    line('Appetite and digestion', input.appetite_digestion),
    line('Body climate', input.body_climate),
    line('Energy pattern', input.energy_pattern),
    line('Meal rhythm', input.meal_rhythm),
    line('Sleep rhythm', input.sleep_rhythm),
    line('Realistic rituals', rituals),
    '',
    'INNER CLIMATE & PREPARATION',
    line('Stress response', input.stress_response),
    line('Emotional support', input.emotional_support),
    line('Change style', input.change_style),
    line('Preferred format', input.preferred_format),
    '',
    'SAFETY SCREEN',
    line('Outcome', safety.urgent
      ? 'URGENT — stop and direct to medical assessment'
      : safety.reviewRequired
        ? 'Human safety review required before recommendation'
        : 'No listed safety concern'),
    line('Responses', safety.flags.join('; ')),
    line('Safety screen version', input.safety_screen_version),
    '',
    'NEXT STEP',
    'Please review this context and let me know if you need any clarification before preparing a recommendation.',
    '',
    consent,
  ].filter((value) => value !== null).join('\n');
}

export function buildWhatsAppHandoff({
  folioId,
  name,
  concern,
  concerns = [],
  safetyReviewRequired = false,
  urgentSafetyFlag = false,
  folioText,
}) {
  if ((process.env.WHATSAPP_FOLIO_MODE || 'full') === 'summary') {
    const concernLabels = concerns
      .map((item) => typeof item === 'string' ? item : item.label)
      .filter(Boolean);
    return [
      'ANJOORA · PERSONAL CONSULTATION',
      'For human Vaidya review',
      urgentSafetyFlag ? 'URGENT SAFETY FLAG · DO NOT PREPARE A WELLNESS RECOMMENDATION' : null,
      '',
      `Name: ${name}`,
      `Folio ID: ${folioId}`,
      `Primary concern: ${concern}`,
      concernLabels.length > 1 ? `All concerns: ${concernLabels.join(', ')}` : null,
      safetyReviewRequired
        ? 'Safety: Human review required before recommendation'
        : 'Safety: No listed safety concern',
      '',
      'My complete consultation has been submitted to ANJOORA. Please review my folio and let me know if any clarification is required.',
    ].filter((value) => value !== null).join('\n');
  }
  return `${folioText}\n\nFolio ID: ${folioId}`;
}
