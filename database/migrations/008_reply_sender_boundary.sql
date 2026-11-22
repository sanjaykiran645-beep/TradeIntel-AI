-- Reply sending is isolated behind administrator-provisioned restricted roles.
-- The migration runner supplies their actual identifiers through
-- REPLY_SEND_OWNER_ROLE and REPLY_SENDER_ROLE. No deployed role names are
-- assumed here. The owner role must be NOLOGIN and own the SECURITY DEFINER
-- functions; the sender role must be NOLOGIN and receive EXECUTE only.
-- The DATABASE_URL login must not be superuser, table owner, or a member of
-- either role. The REPLY_SENDER_DATABASE_URL login may execute sender
-- functions but must not be a member of the owner role.
DO $$
DECLARE
  owner_role text := nullif(current_setting('tradeintel.reply_send_owner_role', true), '');
  sender_role text := nullif(current_setting('tradeintel.reply_sender_role', true), '');
  owner_can_login boolean;
  sender_can_login boolean;
BEGIN
  IF owner_role IS NULL OR sender_role IS NULL THEN
    RAISE EXCEPTION 'Reply sender role identifiers must be supplied by a database administrator';
  END IF;
  IF to_regrole(owner_role) IS NULL OR to_regrole(sender_role) IS NULL THEN
    RAISE EXCEPTION 'Reply sender roles must be provisioned by a database administrator before migration 008';
  END IF;
  SELECT rolcanlogin INTO owner_can_login FROM pg_roles WHERE rolname = owner_role;
  SELECT rolcanlogin INTO sender_can_login FROM pg_roles WHERE rolname = sender_role;
  IF owner_can_login OR sender_can_login THEN
    RAISE EXCEPTION 'Reply sender group roles must be NOLOGIN roles';
  END IF;
  IF pg_has_role(sender_role::name, owner_role::name, 'MEMBER') THEN
    RAISE EXCEPTION 'The sender execution role must not be a member of the function owner role';
  END IF;
END;
$$;

ALTER TABLE public.response_drafts
  ADD COLUMN send_attempt_id uuid,
  ADD CONSTRAINT response_drafts_send_attempt_id_check
    CHECK ((send_state = 'NOT_SENT' AND send_attempt_id IS NULL)
        OR (send_state <> 'NOT_SENT' AND send_attempt_id IS NOT NULL));

DO $$
DECLARE
  owner_role text := current_setting('tradeintel.reply_send_owner_role');
  sender_role text := current_setting('tradeintel.reply_sender_role');
  audit_sequence text;
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', owner_role, sender_role);
  EXECUTE format('GRANT USAGE ON TYPE public.response_drafts TO %I, %I', owner_role, sender_role);
  EXECUTE format('GRANT SELECT ON public.response_drafts, public.inbox_messages, public.contacts, public.outreach_emails TO %I', owner_role);
  EXECUTE format('GRANT UPDATE (send_state, send_attempted_at, send_attempt_id, send_error, sent_at, provider_message_id) ON public.response_drafts TO %I', owner_role);
  EXECUTE format('GRANT INSERT ON public.audit_logs TO %I', owner_role);
  audit_sequence := pg_get_serial_sequence('public.audit_logs', 'id');
  IF audit_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', audit_sequence, owner_role);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_response_draft_send_state_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  trusted_owner name;
BEGIN
  SELECT pg_get_userbyid(proowner)::name INTO trusted_owner
    FROM pg_proc
   WHERE oid = 'public.claim_response_draft_send(bigint,uuid,text)'::regprocedure;
  IF (trusted_owner IS NULL OR current_user <> trusted_owner)
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

DROP TRIGGER IF EXISTS response_drafts_send_state_writer_guard ON public.response_drafts;
CREATE TRIGGER response_drafts_send_state_writer_guard
BEFORE UPDATE OF send_state, send_attempted_at, send_attempt_id, send_error, sent_at, provider_message_id
ON public.response_drafts
FOR EACH ROW EXECUTE FUNCTION public.guard_response_draft_send_state_writer();

CREATE OR REPLACE FUNCTION public.claim_response_draft_send(
  p_draft_id bigint,
  p_attempt_id uuid,
  p_actor_email text
)
RETURNS SETOF public.response_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed public.response_drafts%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'Reply send attempt identifier is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.response_drafts AS draft
     SET send_state = 'SENDING',
         send_attempted_at = clock_timestamp(),
         send_attempt_id = p_attempt_id,
         send_error = NULL,
         sent_at = NULL,
         provider_message_id = NULL
   WHERE draft.id = p_draft_id
     AND draft.status = 'APPROVED'
     AND draft.send_state IN ('NOT_SENT', 'FAILED')
     AND draft.dataset_id IS NOT NULL
     AND NULLIF(btrim(draft.subject), '') IS NOT NULL
     AND NULLIF(btrim(draft.body_text), '') IS NOT NULL
     AND draft.recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     AND EXISTS (
       SELECT 1
         FROM public.inbox_messages AS inbox
         JOIN public.contacts AS contact
           ON contact.id = inbox.contact_id
          AND contact.dataset_id = draft.dataset_id
        WHERE inbox.id = draft.inbox_message_id
          AND inbox.dataset_id = draft.dataset_id
          AND lower(inbox.sender_email) = lower(draft.recipient_email)
          AND lower(contact.email) = lower(draft.recipient_email)
          AND contact.verification_status = 'VERIFIED'
          AND coalesce(contact.is_suppressed, false) = false
          AND upper(coalesce(inbox.intent, '')) NOT IN ('UNSUBSCRIBE', 'NOT_INTERESTED', 'WRONG_RECIPIENT')
          AND NOT EXISTS (
            SELECT 1 FROM public.outreach_emails AS outreach
             WHERE outreach.id = inbox.outreach_id
               AND outreach.dataset_id = draft.dataset_id
               AND outreach.status = 'BOUNCED'
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.contacts AS suppressed
        WHERE lower(suppressed.email) = lower(draft.recipient_email)
          AND suppressed.is_suppressed = true
     )
   RETURNING draft.* INTO claimed;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (dataset_id, user_email, action, entity_type, entity_id, details, created_at)
  VALUES (claimed.dataset_id, p_actor_email, 'RESPONSE_DRAFT_SEND_CLAIMED', 'response_drafts',
          claimed.id::text, jsonb_build_object('attemptId', p_attempt_id, 'outcome', 'SENDING'), clock_timestamp());
  RETURN NEXT claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_response_draft_send(
  p_draft_id bigint,
  p_attempt_id uuid,
  p_actor_email text,
  p_outcome text,
  p_smtp_code integer,
  p_smtp_stage text,
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
  IF p_outcome = 'SENT' AND (p_smtp_code IS NULL OR p_smtp_code < 200 OR p_smtp_code >= 300) THEN
    RAISE EXCEPTION 'SENT requires confirmed SMTP acceptance' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED'
     AND NOT ((p_smtp_code BETWEEN 400 AND 599) OR p_smtp_stage = 'PRE_SUBMISSION') THEN
    RAISE EXCEPTION 'FAILED requires definite non-acceptance evidence' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IN ('FAILED', 'UNKNOWN') AND NULLIF(btrim(p_send_error), '') IS NULL THEN
    RAISE EXCEPTION 'A sanitized outcome description is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.response_drafts AS draft
     SET send_state = p_outcome,
         send_error = CASE WHEN p_outcome IN ('FAILED', 'UNKNOWN') THEN left(p_send_error, 240) ELSE NULL END,
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
                             'smtpCode', p_smtp_code, 'smtpStage', left(coalesce(p_smtp_stage, 'UNKNOWN'), 32),
                             'providerMessageId', CASE WHEN p_outcome = 'SENT' THEN left(p_provider_message_id, 512) ELSE NULL END),
          clock_timestamp());
  RETURN true;
END;
$$;

DO $$
DECLARE
  owner_role text := current_setting('tradeintel.reply_send_owner_role');
  sender_role text := current_setting('tradeintel.reply_sender_role');
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.claim_response_draft_send(bigint, uuid, text) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.finalize_response_draft_send(bigint, uuid, text, text, integer, text, text, text) FROM PUBLIC';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.claim_response_draft_send(bigint, uuid, text) TO %I', sender_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.finalize_response_draft_send(bigint, uuid, text, text, integer, text, text, text) TO %I', sender_role);
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION public.claim_response_draft_send(bigint, uuid, text) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION public.finalize_response_draft_send(bigint, uuid, text, text, integer, text, text, text) OWNER TO %I', owner_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_role);
END;
$$;

COMMENT ON COLUMN public.response_drafts.send_attempt_id IS
  'UUID for the latest claim; finalization must match it so an old worker cannot finalize a newer attempt.';
COMMENT ON FUNCTION public.claim_response_draft_send(bigint, uuid, text) IS
  'Atomically claims only an approved, eligible reply draft and writes the claim audit row in the same transaction.';
COMMENT ON FUNCTION public.finalize_response_draft_send(bigint, uuid, text, text, integer, text, text, text) IS
  'Finalizes only the matching SENDING attempt and writes its audit row atomically. The trusted sender derives SMTP outcome; this function cannot prove provider behavior.';
