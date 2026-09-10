DELETE FROM sessions
WHERE staff_user_id IN (SELECT id FROM staff_users WHERE active=true);

UPDATE staff_users
SET must_rotate_password=true,
    failed_login_count=0,
    locked_until=NULL,
    updated_at=now()
WHERE active=true;

INSERT INTO audit_events(id,entity_type,entity_id,action,payload)
SELECT md5('009-force-staff-credential-revalidation:' || id::text)::uuid,
       'STAFF_USER',id,'CREDENTIAL_REVALIDATION_REQUIRED',
       '{"reason":"P0 go-live credential revalidation","sessions_revoked":true}'::jsonb
FROM staff_users
WHERE active=true
ON CONFLICT (id) DO NOTHING;
