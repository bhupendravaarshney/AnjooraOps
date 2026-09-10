import { normalizePhone } from './phone.js';

export class ConsultationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConsultationInputError';
  }
}

export const CONSENT_VERSION = '2026-09-v1';
export const CONSENT_TEXT = 'I consent to ANJOORA using these details to contact me on WhatsApp for human review, recommendation, acceptance and payment communication. I understand that submitting this consultation does not place an order or make a payment.';

export function consultationConsentPolicy() {
  const version = String(process.env.CONSULTATION_CONSENT_VERSION || CONSENT_VERSION).trim();
  const text = String(process.env.CONSULTATION_CONSENT_TEXT || CONSENT_TEXT).trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(version)) throw new Error('CONSULTATION_CONSENT_VERSION is invalid.');
  if (text.length < 40 || text.length > 1000) throw new Error('CONSULTATION_CONSENT_TEXT must contain 40-1000 characters.');
  return { version, text };
}

export const CONCERN_LABELS = Object.freeze([
  'Calm',
  'Sleep',
  'Focus',
  'Energy',
  'Digestion',
  'Skin',
  'Hair',
  'Body Comfort',
  'Women’s Wellness',
  'Home & Aroma',
  'Child Care',
]);

const concernByKey = new Map(CONCERN_LABELS.map((label) => [concernKey(label), label]));
const allowedFields = new Set([
  'name', 'whatsapp', 'phone', 'city', 'language', 'best_time_to_message', 'best_contact_time',
  'primary_concern', 'concern', 'concerns', 'main_goal', 'duration', 'daily_effect',
  'appetite_digestion', 'body_climate', 'energy_pattern', 'meal_rhythm', 'sleep_rhythm',
  'realistic_rituals', 'stress_response', 'emotional_support', 'change_style', 'preferred_format',
  'safety_flags', 'safety', 'questionnaire_version', 'safety_screen_version',
  'consent', 'consent_accepted', 'consent_version', 'submission_id', 'anti_bot_token',
]);

const allowedLanguages = new Map(['English', 'Hindi', 'Hinglish'].map((value) => [value.toLowerCase(), value]));
const allowedContactTimes = new Map(['Morning', 'Afternoon', 'Evening'].map((value) => [value.toLowerCase(), value]));
const allowedFormats = new Set([
  'infusion', 'drops', 'capsules', 'guide', 'tea', 'powder', 'capsule', 'topical',
  'Botanical infusion', 'Concentrated drops', 'Capsules',
  'Herbal tea or infusion', 'Powder or blend', 'Capsule or tablet',
  'Oil, balm or topical ritual', 'Help me choose', 'Team to recommend',
]);

export const SAFETY_FLAG_DEFINITIONS = Object.freeze({
  medication: Object.freeze({
    label: 'Takes prescription medicines regularly',
    severity: 'REVIEW',
  }),
  pregnancy: Object.freeze({
    label: 'Pregnant, breastfeeding or trying to conceive',
    severity: 'REVIEW',
  }),
  allergy: Object.freeze({
    label: 'Known herb, food or fragrance allergy',
    severity: 'REVIEW',
  }),
  child: Object.freeze({
    label: 'Plan is for a child',
    severity: 'REVIEW',
  }),
  'urgent-chest': Object.freeze({
    label: 'New chest pain, severe breathlessness or fainting',
    severity: 'URGENT',
  }),
  'urgent-neuro': Object.freeze({
    label: 'Sudden weakness, confusion or difficulty speaking',
    severity: 'URGENT',
  }),
  'urgent-bleeding': Object.freeze({
    label: 'Vomiting blood, black stools or uncontrolled bleeding',
    severity: 'URGENT',
  }),
  none: Object.freeze({
    label: 'None of the listed safety concerns apply',
    severity: 'CLEAR',
  }),
  'not-provided': Object.freeze({
    label: 'Safety screen was not provided',
    severity: 'REVIEW',
  }),
});

function cleanText(value, field, maximum) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ConsultationInputError(`${field} must be text.`);
  }
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (cleaned.length > maximum) {
    throw new ConsultationInputError(`${field} must be ${maximum} characters or fewer.`);
  }
  return cleaned;
}

export function concernKey(label) {
  const key = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  if (!key) {
    throw new ConsultationInputError('Each concern must contain at least one letter or number.');
  }
  return key;
}

export function normalizeConcerns(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConsultationInputError('Consultation input must be an object.');
  }

  const primaryLabel = cleanText(
    input.primary_concern ?? input.concern,
    'primary_concern',
    80,
  );

  let submitted = input.concerns;
  if (submitted === undefined || submitted === null) submitted = [];
  if (!Array.isArray(submitted)) {
    throw new ConsultationInputError('concerns must be an array.');
  }

  const source = submitted.length ? submitted : primaryLabel ? [primaryLabel] : [];
  const unique = [];
  const seen = new Set();

  for (let index = 0; index < source.length; index += 1) {
    const submittedLabel = cleanText(source[index], `concerns[${index}]`, 80);
    if (!submittedLabel) continue;
    const key = concernKey(submittedLabel);
    const label = concernByKey.get(key);
    if (!label) throw new ConsultationInputError(`Unsupported concern: ${submittedLabel}.`);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ key, label });
  }

  if (!unique.length) {
    throw new ConsultationInputError('At least one concern is required.');
  }
  if (unique.length > 4) {
    throw new ConsultationInputError('A maximum of four concerns can be submitted.');
  }

  const resolvedPrimary = primaryLabel || unique[0].label;
  const primaryKey = concernKey(resolvedPrimary);
  if (!seen.has(primaryKey)) {
    throw new ConsultationInputError('primary_concern must also be present in concerns.');
  }

  return unique.map((item, index) => ({
    ...item,
    isPrimary: item.key === primaryKey,
    position: index + 1,
  }));
}

export function normalizeSafetyFlags(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConsultationInputError('Consultation input must be an object.');
  }

  let submitted = input.safety_flags ?? input.safety;
  if (submitted === undefined || submitted === null || submitted.length === 0) {
    submitted = ['not-provided'];
  }
  if (typeof submitted === 'string') submitted = [submitted];
  if (!Array.isArray(submitted)) {
    throw new ConsultationInputError('safety_flags must be an array.');
  }

  const uniqueCodes = [];
  const seen = new Set();
  for (let index = 0; index < submitted.length; index += 1) {
    const code = cleanText(submitted[index], `safety_flags[${index}]`, 64).toLowerCase();
    if (!code || seen.has(code)) continue;
    if (!SAFETY_FLAG_DEFINITIONS[code]) {
      throw new ConsultationInputError(`Unsupported safety flag: ${code}.`);
    }
    seen.add(code);
    uniqueCodes.push(code);
  }

  if (!uniqueCodes.length) uniqueCodes.push('not-provided');
  if (uniqueCodes.includes('none') && uniqueCodes.length > 1) {
    throw new ConsultationInputError('The none safety option cannot be combined with another flag.');
  }

  const flags = uniqueCodes.map((code, index) => ({
    code,
    ...SAFETY_FLAG_DEFINITIONS[code],
    position: index + 1,
  }));
  const urgent = flags.some((flag) => flag.severity === 'URGENT');
  const reviewRequired = flags.some((flag) => flag.severity !== 'CLEAR');

  return {
    flags,
    urgent,
    reviewRequired,
    outcome: urgent ? 'URGENT' : reviewRequired ? 'REVIEW_REQUIRED' : 'CLEAR',
  };
}

export function normalizeConsultationContext(input) {
  const concerns = normalizeConcerns(input);
  const safety = normalizeSafetyFlags(input);
  return {
    concerns,
    primaryConcern: concerns.find((item) => item.isPrimary),
    safety,
  };
}

function optionalText(input, field, maximum) {
  const value = cleanText(input[field], field, maximum);
  return value || null;
}

function allowedValue(value, field, values) {
  if (!value) return null;
  const normalized = values instanceof Map ? values.get(value.toLowerCase()) : values.has(value) ? value : null;
  if (!normalized) throw new ConsultationInputError(`Unsupported ${field}: ${value}.`);
  return normalized;
}

export function normalizeConsultationPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConsultationInputError('Consultation input must be an object.');
  }
  const unexpected = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unexpected.length) {
    throw new ConsultationInputError(`Unexpected field: ${unexpected[0]}.`);
  }

  const submissionId = cleanText(input.submission_id, 'submission_id', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    throw new ConsultationInputError('submission_id must be a valid UUID.');
  }

  const name = cleanText(input.name, 'name', 100);
  if (name.length < 2 || !/^[\p{L}\p{M} .’'-]+$/u.test(name)) {
    throw new ConsultationInputError('name must contain 2–100 valid name characters.');
  }
  const phone = normalizePhone(input.whatsapp ?? input.phone);
  if (!phone) throw new ConsultationInputError('whatsapp must be a valid Indian mobile or international E.164 number.');
  if (input.consent !== true && input.consent_accepted !== true) {
    throw new ConsultationInputError('Consent is required before submission.');
  }
  const consentPolicy = consultationConsentPolicy();
  const consentVersion = cleanText(input.consent_version, 'consent_version', 80);
  if (consentVersion !== consentPolicy.version) {
    throw new ConsultationInputError('The consent text changed. Reload the page and review the current consent before submitting.');
  }

  const context = normalizeConsultationContext(input);
  const languageRaw = optionalText(input, 'language', 20);
  const contactTimeRaw = optionalText(
    { value: input.best_time_to_message ?? input.best_contact_time },
    'value',
    20,
  );
  const format = optionalText(input, 'preferred_format', 40);
  const questionnaireVersion = optionalText(input, 'questionnaire_version', 20) || '1.0';
  const safetyScreenVersion = optionalText(input, 'safety_screen_version', 20) || '1.0';
  if (questionnaireVersion !== '1.0' || safetyScreenVersion !== '1.0') {
    throw new ConsultationInputError('Unsupported questionnaire or safety-screen version.');
  }

  let rituals = input.realistic_rituals ?? [];
  if (!Array.isArray(rituals) || rituals.length > 8) {
    throw new ConsultationInputError('realistic_rituals must contain no more than eight items.');
  }
  rituals = rituals.map((value, index) => cleanText(value, `realistic_rituals[${index}]`, 120)).filter(Boolean);

  return {
    submissionId,
    name,
    phone,
    city: optionalText(input, 'city', 80),
    language: allowedValue(languageRaw, 'language', allowedLanguages),
    bestContactTime: allowedValue(contactTimeRaw, 'best contact time', allowedContactTimes),
    context,
    mainGoal: optionalText(input, 'main_goal', 300),
    duration: optionalText(input, 'duration', 120),
    dailyEffect: optionalText(input, 'daily_effect', 120),
    appetiteDigestion: optionalText(input, 'appetite_digestion', 160),
    bodyClimate: optionalText(input, 'body_climate', 120),
    energyPattern: optionalText(input, 'energy_pattern', 120),
    mealRhythm: optionalText(input, 'meal_rhythm', 120),
    sleepRhythm: optionalText(input, 'sleep_rhythm', 120),
    realisticRituals: rituals,
    stressResponse: optionalText(input, 'stress_response', 160),
    emotionalSupport: optionalText(input, 'emotional_support', 160),
    changeStyle: optionalText(input, 'change_style', 120),
    preferredFormat: allowedValue(format, 'preferred format', allowedFormats),
    questionnaireVersion,
    safetyScreenVersion,
    consentVersion,
  };
}
