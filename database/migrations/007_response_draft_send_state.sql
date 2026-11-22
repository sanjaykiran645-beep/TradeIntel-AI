-- Track reply delivery independently from response_drafts.status, which records
-- the existing review/approval workflow. An interrupted SENDING row is never
-- made claimable by time alone; it requires explicit reconciliation.
ALTER TABLE public.response_drafts
  ADD COLUMN send_state text NOT NULL DEFAULT 'NOT_SENT',
  ADD COLUMN send_attempted_at timestamptz,
  ADD COLUMN send_error text,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN provider_message_id text,
  ADD CONSTRAINT response_drafts_send_state_check
    CHECK (send_state IN ('NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  ADD CONSTRAINT response_drafts_send_timestamps_check
    CHECK (
      (send_state = 'NOT_SENT' AND send_attempted_at IS NULL AND sent_at IS NULL)
      OR (send_state IN ('SENDING', 'FAILED', 'UNKNOWN') AND send_attempted_at IS NOT NULL AND sent_at IS NULL)
      OR (send_state = 'SENT' AND send_attempted_at IS NOT NULL AND sent_at IS NOT NULL)
    ),
  ADD CONSTRAINT response_drafts_send_error_check
    CHECK (
      (send_state IN ('FAILED', 'UNKNOWN') AND NULLIF(btrim(send_error), '') IS NOT NULL)
      OR (send_state NOT IN ('FAILED', 'UNKNOWN') AND send_error IS NULL)
    );

COMMENT ON COLUMN public.response_drafts.send_state IS
  'Delivery state independent of approval status. Claim with one conditional UPDATE requiring status=APPROVED and send_state IN (NOT_SENT, FAILED); FAILED means SMTP definitively did not accept the recipient. UNKNOWN and interrupted SENDING require manual reconciliation and are never retry-eligible by age.';
COMMENT ON COLUMN public.response_drafts.send_attempted_at IS
  'Timestamp of the atomic claim before SMTP is called; a stale value never authorizes an automatic retry.';
COMMENT ON COLUMN public.response_drafts.send_error IS
  'Sanitized delivery outcome only. Store no credentials, SMTP configuration, or raw sensitive provider diagnostics.';
COMMENT ON COLUMN public.response_drafts.sent_at IS
  'Set only after SMTP acceptance of the intended recipient is confirmed.';
COMMENT ON COLUMN public.response_drafts.provider_message_id IS
  'SMTP provider message identifier when returned; it is diagnostic and does not provide exactly-once delivery.';
