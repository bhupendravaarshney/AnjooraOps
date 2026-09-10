export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'staff_register_approved',
  'staff_passwords_rotated',
  'staff_mfa_verified',
  'staff_least_privilege_verified',
  'production_secrets_stored',
  'database_tls_verified',
  'integration_secret_match',
  'meta_business_connected',
  'meta_webhook_registered',
  'meta_templates_approved',
  'whatsapp_scenarios_passed',
  'schedules_active',
  'operational_alerts_active',
  'test_alert_received',
  'incident_drill_completed',
  'payment_provider_certified',
  'payment_scenarios_passed',
  'reconciliation_test_passed',
  'unpaid_fulfillment_block_verified',
  'managed_backups_pitr_active',
  'backup_access_audited',
  'backup_alerts_active',
  'restore_drill_passed',
  'privacy_policy_approved',
  'privacy_roles_approved',
  'privacy_request_scenarios_passed',
  'staging_deployed',
  'automated_verification_passed',
  'end_to_end_journey_passed',
  'role_matrix_passed',
  'provider_failure_replay_passed',
  'monitoring_support_rollback_confirmed',
]);

export const REQUIRED_SIGNOFFS = Object.freeze([
  'release_owner', 'business_owner', 'clinical_owner', 'privacy_owner', 'infrastructure_owner',
]);

function realHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      && !/(?:^|\.)(?:test|example|invalid)(?:\.|$)/.test(url.hostname)
      && !/placeholder|your-domain/i.test(url.hostname);
  } catch { return false; }
}

function validEvidenceRecord(record, now) {
  if (!record || record.passed !== true) return 'is not marked passed';
  if (String(record.owner || '').trim().length < 2) return 'has no named owner';
  if (String(record.evidence_ref || '').trim().length < 3) return 'has no evidence reference';
  const verifiedAt = new Date(record.verified_at || '');
  if (Number.isNaN(verifiedAt.getTime()) || verifiedAt > now) return 'has an invalid or future verified_at timestamp';
  return null;
}

export function releaseEvidenceFindings(evidence, {
  releaseCandidate,
  paymentProvider,
  paymentAdapterId,
  whatsappBusinessAccountId,
  consentVersion,
  privacyApprovalId,
  rpoHours,
  rtoMinutes,
  now = new Date(),
} = {}) {
  const findings = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ['Release evidence must be a JSON object.'];
  if (evidence.evidence_version !== 1) findings.push('evidence_version must be 1.');
  if (String(evidence.release_candidate || '').trim().length < 3) findings.push('release_candidate is required.');
  if (String(evidence.release_candidate || '').trim() !== String(releaseCandidate || '').trim()) {
    findings.push('release_candidate does not match the deployed RELEASE_CANDIDATE.');
  }
  if (!realHttpsUrl(evidence.staging_url)) findings.push('staging_url must be a real HTTPS URL.');
  if (String(evidence.payment_provider || '').trim().toUpperCase() !== String(paymentProvider || '').trim().toUpperCase()) {
    findings.push('payment_provider does not match the deployed PAYMENT_PROVIDER.');
  }
  if (String(evidence.payment_adapter_id || '').trim() !== String(paymentAdapterId || '').trim()) {
    findings.push('payment_adapter_id does not match the deployed PAYMENT_ADAPTER_ID.');
  }
  if (String(evidence.whatsapp_business_account_id || '').trim() !== String(whatsappBusinessAccountId || '').trim()) {
    findings.push('whatsapp_business_account_id does not match the deployed WHATSAPP_BUSINESS_ACCOUNT_ID.');
  }
  if (String(evidence.consent_version || '').trim() !== String(consentVersion || '').trim()) {
    findings.push('consent_version does not match CONSULTATION_CONSENT_VERSION.');
  }
  if (String(evidence.privacy_approval_id || '').trim() !== String(privacyApprovalId || '').trim()) {
    findings.push('privacy_approval_id does not match PRIVACY_APPROVAL_ID.');
  }
  if (Number(evidence.approved_rpo_hours) !== Number(rpoHours)) findings.push('approved_rpo_hours does not match BACKUP_RPO_HOURS.');
  if (Number(evidence.approved_rto_minutes) !== Number(rtoMinutes)) findings.push('approved_rto_minutes does not match BACKUP_RTO_MINUTES.');

  const checkTimes = [];
  for (const checkName of REQUIRED_RELEASE_CHECKS) {
    const record = evidence.checks?.[checkName];
    const error = validEvidenceRecord(record, now);
    if (error) findings.push(`checks.${checkName} ${error}.`);
    else checkTimes.push(new Date(record.verified_at).getTime());
  }
  const latestCheckTime = checkTimes.length ? Math.max(...checkTimes) : null;
  for (const signoffName of REQUIRED_SIGNOFFS) {
    const signoff = evidence.signoffs?.[signoffName];
    const error = validEvidenceRecord(signoff && { ...signoff, passed: signoff.approved }, now);
    if (error) findings.push(`signoffs.${signoffName} ${error}.`);
    else if (latestCheckTime !== null && new Date(signoff.verified_at).getTime() < latestCheckTime) {
      findings.push(`signoffs.${signoffName} was recorded before the latest release check.`);
    }
  }
  return findings;
}
