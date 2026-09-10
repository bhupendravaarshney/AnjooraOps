export const CAPABILITIES = Object.freeze([
  'DASHBOARD',
  'CONSULTATIONS_VIEW',
  'CLINICAL_REVIEW',
  'OPERATIONS',
  'WHATSAPP',
  'PRIVACY',
  'STAFF_MANAGEMENT',
]);

export const ROLE_CAPABILITIES = Object.freeze({
  ADMIN: Object.freeze([...CAPABILITIES]),
  VAIDYA: Object.freeze(['DASHBOARD', 'CONSULTATIONS_VIEW', 'CLINICAL_REVIEW', 'WHATSAPP']),
  OPERATIONS: Object.freeze(['DASHBOARD', 'CONSULTATIONS_VIEW', 'OPERATIONS']),
  SUPPORT: Object.freeze(['DASHBOARD', 'WHATSAPP']),
});

export function roleCan(role, capability) {
  if (!CAPABILITIES.includes(capability)) return false;
  return ROLE_CAPABILITIES[role]?.includes(capability) === true;
}
