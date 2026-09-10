export const REQUIRED_MIGRATIONS = Object.freeze([
  '001_init.sql',
  '002_multi_concern_safety.sql',
  '003_operational_hardening.sql',
  '004_followup_constraints.sql',
  '005_operational_pagination.sql',
  '006_messaging_lookup_indexes.sql',
  '007_operational_job_runs.sql',
  '008_payment_certification_controls.sql',
  '009_force_staff_credential_revalidation.sql',
  '010_formula_ingredient_catalog.sql',
  '011_remove_staff_mfa.sql',
]);

export function missingRequiredMigrations(appliedNames) {
  const applied = new Set(Array.isArray(appliedNames) ? appliedNames.map(String) : []);
  return REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));
}
