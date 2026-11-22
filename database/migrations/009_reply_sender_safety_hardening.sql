-- Forward-only hardening for installations that may already have recorded
-- 008_reply_sender_boundary. SMTP outcome evidence is asserted by the trusted
-- server sender; PostgreSQL cannot independently prove what the SMTP server did.
-- REPLY_SEND_MIGRATION_LOGIN_ROLE identifies the narrowly scoped migration login;
-- it must be the only non-superuser LOGIN member of the function-owner role.
DO $$
DECLARE
  owner_role text := nullif(current_setting('tradeintel.reply_send_owner_role', true), '');
  sender_role text := nullif(current_setting('tradeintel.reply_sender_role', true), '');
  app_role text := nullif(current_setting('tradeintel.reply_send_app_role', true), '');
  sender_login text := nullif(current_setting('tradeintel.reply_sender_login_role', true), '');
  migration_login text := nullif(current_setting('tradeintel.reply_send_migration_login_role', true), '');
  table_owner oid;
  app_super boolean;
  app_can_login boolean;
  sender_super boolean;
  sender_can_login boolean;
  sender_group_super boolean;
  sender_group_can_login boolean;
  owner_super boolean;
  owner_can_login boolean;
  migration_super boolean;
  migration_create_role boolean;
  migration_create_db boolean;
  migration_replication boolean;
  migration_bypass_rls boolean;
  app_can_set_replication_role boolean := false;
  sender_can_set_replication_role boolean := false;
  migration_can_set_replication_role boolean := false;
BEGIN
  IF owner_role IS NULL OR sender_role IS NULL OR app_role IS NULL OR sender_login IS NULL OR migration_login IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires owner, sender group, application login, sender login, and migration login role identifiers';
  END IF;
  IF to_regrole(owner_role) IS NULL OR to_regrole(sender_role) IS NULL
     OR to_regrole(app_role) IS NULL OR to_regrole(sender_login) IS NULL OR to_regrole(migration_login) IS NULL THEN
    RAISE EXCEPTION 'All reply-sender roles must be provisioned before migration 009';
  END IF;

  SELECT relowner INTO table_owner
    FROM pg_class WHERE oid = 'public.response_drafts'::regclass;
  SELECT rolsuper, rolcanlogin INTO app_super, app_can_login
    FROM pg_roles WHERE rolname = app_role;
  SELECT rolsuper, rolcanlogin INTO sender_super, sender_can_login
    FROM pg_roles WHERE rolname = sender_login;
  SELECT rolsuper, rolcanlogin INTO sender_group_super, sender_group_can_login
    FROM pg_roles WHERE rolname = sender_role;
  SELECT rolsuper, rolcanlogin INTO owner_super, owner_can_login
    FROM pg_roles WHERE rolname = owner_role;
  SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    INTO migration_super, migration_create_role, migration_create_db, migration_replication, migration_bypass_rls
    FROM pg_roles WHERE rolname = migration_login;

  IF owner_super OR owner_can_login OR sender_group_super OR sender_group_can_login
     OR NOT app_can_login OR NOT sender_can_login THEN
    RAISE EXCEPTION 'Owner and sender groups must be non-superuser NOLOGIN roles; application and sender connection roles must be LOGIN roles';
  END IF;
  IF app_super OR sender_super
     OR pg_has_role(app_role::name, table_owner, 'MEMBER')
     OR pg_has_role(sender_login::name, table_owner, 'MEMBER')
     OR pg_has_role(app_role::name, owner_role::name, 'MEMBER')
     OR pg_has_role(sender_login::name, owner_role::name, 'MEMBER')
     OR pg_has_role(sender_role::name, owner_role::name, 'MEMBER')
     OR pg_has_role(owner_role::name, sender_role::name, 'MEMBER')
     OR pg_has_role(app_role::name, sender_role::name, 'MEMBER')
     OR NOT pg_has_role(sender_login::name, sender_role::name, 'MEMBER')
     OR sender_login = app_role THEN
    RAISE EXCEPTION 'Application and sender logins violate the restricted role boundary';
  END IF;
  IF current_user <> migration_login::name
     OR migration_super OR migration_create_role OR migration_create_db OR migration_replication OR migration_bypass_rls THEN
    RAISE EXCEPTION 'Migration executor identity is mismatched or has privileges beyond the scoped migration role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace AS schema_row
     WHERE schema_row.oid = 'public'::regnamespace
       AND (schema_row.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         OR EXISTS (
           SELECT 1 FROM aclexplode(schema_row.nspacl) AS privilege
            WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND privilege.privilege_type = 'CREATE'
              AND privilege.is_grantable
         ))
  ) THEN
    RAISE EXCEPTION 'Migration executor requires direct CREATE grant option on schema public';
  END IF;
  -- PostgreSQL 15+ supports per-parameter SET grants. Replica mode suppresses
  -- ordinary triggers, so none of these operational logins may hold that grant.
  IF current_setting('server_version_num')::integer >= 150000 THEN
    EXECUTE 'SELECT has_parameter_privilege($1::name, $2, $3)'
      INTO app_can_set_replication_role
      USING app_role, 'session_replication_role', 'SET';
    EXECUTE 'SELECT has_parameter_privilege($1::name, $2, $3)'
      INTO sender_can_set_replication_role
      USING sender_login, 'session_replication_role', 'SET';
    EXECUTE 'SELECT has_parameter_privilege($1::name, $2, $3)'
      INTO migration_can_set_replication_role
      USING migration_login, 'session_replication_role', 'SET';
    IF app_can_set_replication_role OR sender_can_set_replication_role OR migration_can_set_replication_role THEN
      RAISE EXCEPTION 'Application, sender, and migration logins must not be able to set session_replication_role';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles AS member_role
     WHERE member_role.oid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND member_role.rolname <> owner_role
       AND pg_has_role(current_user, member_role.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'Migration executor has role memberships beyond the dedicated function-owner group';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND login_role.rolname <> sender_login
       AND pg_has_role(login_role.rolname, sender_role::name, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'Only the configured sender login may be a member of the sender execution role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND login_role.rolname <> migration_login::name
       AND pg_has_role(login_role.oid, to_regrole(owner_role), 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'Only the migration executor and trusted superusers may be members of the SECURITY DEFINER owner role';
  END IF;
  IF pg_has_role(current_user, owner_role::name, 'MEMBER') IS NOT TRUE
     AND (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS NOT TRUE THEN
    RAISE EXCEPTION 'Migration executor must be able to assume the function owner role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS proc
     WHERE proc.oid = to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)')::oid
       AND proc.prosecdef
       AND proc.proowner = to_regrole(owner_role)::oid
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS proc
     WHERE proc.oid = to_regprocedure('public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text)')::oid
       AND proc.prosecdef
       AND proc.proowner = to_regrole(owner_role)::oid
  ) THEN
    RAISE EXCEPTION 'Migration 008 procedures must be SECURITY DEFINER functions owned by the configured non-login owner role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc AS proc
     WHERE proc.proowner = to_regrole(owner_role)::oid
       AND proc.prosecdef
       AND proc.oid NOT IN (
         to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)')::oid,
         to_regprocedure('public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text)')::oid
       )
  ) THEN
    RAISE EXCEPTION 'The reply-send function owner role must not own any other SECURITY DEFINER functions';
  END IF;
  IF has_table_privilege(sender_login, 'public.response_drafts', 'INSERT')
     OR has_any_column_privilege(sender_login, 'public.response_drafts', 'INSERT')
     OR has_table_privilege(sender_login, 'public.response_drafts', 'UPDATE')
     OR has_any_column_privilege(sender_login, 'public.response_drafts', 'UPDATE')
     OR has_table_privilege(sender_login, 'public.response_drafts', 'DELETE')
     OR has_table_privilege(sender_login, 'public.response_drafts', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Sender login has direct response_drafts write privileges';
  END IF;
  -- Deleting a SENT row would erase its non-retryable state; TRUNCATE bypasses
  -- row triggers. The ordinary application login must not have either path.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.response_drafts FROM %I', app_role);
  IF has_table_privilege(app_role, 'public.response_drafts', 'DELETE')
     OR has_table_privilege(app_role, 'public.response_drafts', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Application login retains DELETE or TRUNCATE access to response_drafts';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.response_drafts
     WHERE send_state <> 'NOT_SENT' AND send_attempt_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing non-NOT_SENT drafts lack the attempt identifier required for safe finalization';
  END IF;
END;
$$;

-- Sender access is procedure-only. Effective inherited privileges are checked
-- above for the configured login; this removes any direct grants on its group.
DO $$
DECLARE
  function_oid oid;
  grantee_name name;
  sender_role text := current_setting('tradeintel.reply_sender_role');
  owner_role text := current_setting('tradeintel.reply_send_owner_role');
  app_role text := current_setting('tradeintel.reply_send_app_role');
BEGIN
  EXECUTE format('REVOKE ALL ON public.response_drafts FROM %I', sender_role);
  function_oid := to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)')::oid;
  EXECUTE 'REVOKE ALL ON FUNCTION public.claim_response_draft_send(bigint,uuid,text) FROM PUBLIC';
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname::name
      FROM pg_proc AS proc
      CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
      JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE proc.oid = function_oid
       AND privilege.privilege_type = 'EXECUTE'
       AND grantee.rolname::name NOT IN (owner_role::name, sender_role::name)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.claim_response_draft_send(bigint,uuid,text) FROM %I', grantee_name);
  END LOOP;
  EXECUTE format('REVOKE ALL ON FUNCTION public.claim_response_draft_send(bigint,uuid,text) FROM %I', app_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.claim_response_draft_send(bigint,uuid,text) FROM %I', sender_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.claim_response_draft_send(bigint,uuid,text) TO %I', sender_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_response_draft_send_state_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  trusted_owner name;
BEGIN
  SELECT pg_get_userbyid(proowner)::name INTO trusted_owner
    FROM pg_proc
   WHERE oid = 'public.claim_response_draft_send(bigint,uuid,text)'::regprocedure;

  IF TG_OP = 'INSERT' THEN
    IF NEW.send_state IS DISTINCT FROM 'NOT_SENT'
       OR NEW.send_attempted_at IS NOT NULL
       OR NEW.send_attempt_id IS NOT NULL
       OR NEW.send_error IS NOT NULL
       OR NEW.sent_at IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'New response drafts must begin in the pristine NOT_SENT state'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF current_user IS DISTINCT FROM trusted_owner
     AND (OLD.send_state IS DISTINCT FROM NEW.send_state
       OR OLD.send_attempted_at IS DISTINCT FROM NEW.send_attempted_at
       OR OLD.send_attempt_id IS DISTINCT FROM NEW.send_attempt_id
       OR OLD.send_error IS DISTINCT FROM NEW.send_error
       OR OLD.sent_at IS DISTINCT FROM NEW.sent_at
       OR OLD.provider_message_id IS DISTINCT FROM NEW.provider_message_id) THEN
    RAISE EXCEPTION 'Reply send-state changes must use the restricted sender procedures'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS response_drafts_send_state_insert_guard ON public.response_drafts;
CREATE TRIGGER response_drafts_send_state_insert_guard
BEFORE INSERT ON public.response_drafts
FOR EACH ROW EXECUTE FUNCTION public.guard_response_draft_send_state_writer();

DROP TRIGGER IF EXISTS response_drafts_send_state_writer_guard ON public.response_drafts;
CREATE TRIGGER response_drafts_send_state_writer_guard
BEFORE UPDATE OF send_state, send_attempted_at, send_attempt_id, send_error, sent_at, provider_message_id
ON public.response_drafts
FOR EACH ROW EXECUTE FUNCTION public.guard_response_draft_send_state_writer();

-- Remove the legacy eight-argument finalizer so no login retains access to its
-- weaker evidence contract. The new name and typed evidence argument prevent
-- accidental invocation through stale application code.
DROP FUNCTION IF EXISTS public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text);

CREATE OR REPLACE FUNCTION public.finalize_response_draft_send_v2(
  p_draft_id bigint,
  p_attempt_id uuid,
  p_actor_email text,
  p_outcome text,
  p_smtp_code integer,
  p_smtp_stage text,
  p_outcome_evidence text,
  p_send_error text,
  p_provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated public.response_drafts%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('SENT', 'FAILED', 'UNKNOWN') THEN
    RAISE EXCEPTION 'Invalid reply send outcome' USING ERRCODE = '22023';
  END IF;

  -- These are constrained assertions from the trusted server sender, not
  -- independent proof. Only the sender login may execute this function.
  IF p_outcome = 'SENT' AND (
       p_outcome_evidence IS DISTINCT FROM 'SMTP_ACCEPTED_INTENDED_RECIPIENT'
       OR p_smtp_code IS NULL OR p_smtp_code < 200 OR p_smtp_code >= 300
       OR p_smtp_stage IS DISTINCT FROM 'ACCEPTED'
     ) THEN
    RAISE EXCEPTION 'SENT requires the trusted sender acceptance outcome' USING ERRCODE = '22023';
  END IF;

  IF p_outcome = 'FAILED' AND (
       p_outcome_evidence IS NULL
       OR p_outcome_evidence NOT IN ('SMTP_RECIPIENT_REJECTED', 'SMTP_SERVER_REJECTED', 'SMTP_PRE_SUBMISSION_FAILURE')
     ) THEN
    RAISE EXCEPTION 'FAILED requires a recognized definitive non-acceptance outcome' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED' AND p_outcome_evidence = 'SMTP_RECIPIENT_REJECTED' AND (
       p_smtp_code IS NULL OR p_smtp_code < 400 OR p_smtp_code >= 600
       OR p_smtp_stage IS NULL OR p_smtp_stage NOT IN ('RCPT_TO', 'RECIPIENT_REJECTED')
     ) THEN
    RAISE EXCEPTION 'Recipient rejection evidence is incomplete' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED' AND p_outcome_evidence = 'SMTP_SERVER_REJECTED' AND (
       p_smtp_code IS NULL OR p_smtp_code < 400 OR p_smtp_code >= 600
       OR p_smtp_stage IS NULL OR p_smtp_stage NOT IN ('CONNECT', 'AUTH', 'MAIL_FROM', 'RCPT_TO', 'RECIPIENT_REJECTED', 'DATA')
     ) THEN
    RAISE EXCEPTION 'SMTP server rejection evidence is incomplete' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED' AND p_outcome_evidence = 'SMTP_PRE_SUBMISSION_FAILURE' AND (
       p_smtp_code IS NOT NULL OR p_smtp_stage IS DISTINCT FROM 'PRE_SUBMISSION'
     ) THEN
    RAISE EXCEPTION 'Pre-submission failure evidence is inconsistent' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'UNKNOWN' AND p_outcome_evidence IS DISTINCT FROM 'SMTP_ACCEPTANCE_UNCERTAIN' THEN
    RAISE EXCEPTION 'UNKNOWN requires an explicit uncertain outcome' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IN ('FAILED', 'UNKNOWN') AND (
       NULLIF(btrim(p_send_error), '') IS NULL
       OR p_send_error !~ '^[A-Z0-9_:-]{1,240}$'
     ) THEN
    RAISE EXCEPTION 'A sanitized outcome code is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.response_drafts AS draft
     SET send_state = p_outcome,
         send_error = CASE WHEN p_outcome IN ('FAILED', 'UNKNOWN') THEN p_send_error ELSE NULL END,
         sent_at = CASE WHEN p_outcome = 'SENT' THEN clock_timestamp() ELSE NULL END,
         provider_message_id = CASE WHEN p_outcome = 'SENT' THEN left(p_provider_message_id, 512) ELSE NULL END
   WHERE draft.id = p_draft_id
     AND draft.send_state = 'SENDING'
     AND draft.send_attempt_id = p_attempt_id
   RETURNING draft.* INTO updated;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.audit_logs (dataset_id, user_email, action, entity_type, entity_id, details, created_at)
  VALUES (updated.dataset_id, p_actor_email, 'RESPONSE_DRAFT_SEND_FINALIZED', 'response_drafts',
          updated.id::text,
          jsonb_build_object('attemptId', p_attempt_id, 'outcome', p_outcome,
                             'outcomeEvidence', p_outcome_evidence,
                             'smtpCode', p_smtp_code, 'smtpStage', left(coalesce(p_smtp_stage, 'UNKNOWN'), 32),
                             'providerMessageId', CASE WHEN p_outcome = 'SENT' THEN left(p_provider_message_id, 512) ELSE NULL END),
          clock_timestamp());
  RETURN true;
END;
$$;

DO $$
DECLARE
  function_oid oid;
  grantee_name name;
  owner_role text := current_setting('tradeintel.reply_send_owner_role');
  sender_role text := current_setting('tradeintel.reply_sender_role');
  app_role text := current_setting('tradeintel.reply_send_app_role');
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.guard_response_draft_send_state_writer() FROM PUBLIC';
  EXECUTE format('REVOKE ALL ON FUNCTION public.guard_response_draft_send_state_writer() FROM %I', sender_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.guard_response_draft_send_state_writer() FROM %I', app_role);
  function_oid := to_regprocedure('public.guard_response_draft_send_state_writer()')::oid;
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname::name
      FROM pg_proc AS proc
      CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
      JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE proc.oid = function_oid
       AND privilege.privilege_type = 'EXECUTE'
       AND grantee.rolname::name <> pg_get_userbyid(proc.proowner)::name
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.guard_response_draft_send_state_writer() FROM %I', grantee_name);
  END LOOP;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_role);
  function_oid := to_regprocedure('public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)')::oid;
  EXECUTE format('ALTER FUNCTION public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text) OWNER TO %I', owner_role);
  EXECUTE 'REVOKE ALL ON FUNCTION public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text) FROM PUBLIC';
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname::name
      FROM pg_proc AS proc
      CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
      JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
     WHERE proc.oid = function_oid
       AND privilege.privilege_type = 'EXECUTE'
       AND grantee.rolname::name NOT IN (owner_role::name, sender_role::name)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text) FROM %I', grantee_name);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text) TO %I', sender_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_role);
END;
$$;

COMMENT ON FUNCTION public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text) IS
  'Finalizes the matching claim and audit row atomically. outcome_evidence is a constrained assertion derived by the trusted SMTP sender; PostgreSQL cannot prove provider acceptance or rejection.';
