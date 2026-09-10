INSERT INTO audit_events(id,entity_type,entity_id,action,payload)
SELECT md5('011-remove-staff-mfa:' || id::text)::uuid,
       'STAFF_USER',id,'AUTHENTICATION_POLICY_CHANGED',
       '{"authentication":"PASSWORD_ONLY","mfa_secrets_cleared":true,"sessions_revoked":true}'::jsonb
FROM staff_users
WHERE active=true
ON CONFLICT (id) DO NOTHING;

DELETE FROM sessions;

UPDATE staff_users
SET mfa_enabled=false,
    mfa_secret_encrypted=NULL,
    updated_at=now()
WHERE mfa_enabled=true
   OR mfa_secret_encrypted IS NOT NULL;

COMMENT ON COLUMN staff_users.mfa_enabled IS
  'Deprecated compatibility column. Staff authentication is password-only.';

COMMENT ON COLUMN staff_users.mfa_secret_encrypted IS
  'Deprecated compatibility column. Values were cleared when staff MFA was removed.';
