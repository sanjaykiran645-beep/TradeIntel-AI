import database from './_db-client.js';

export function isValidOutreachEmail(email) {
  if (typeof email !== 'string') return false;
  const address = email.trim();
  if (!address || address.length > 254) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split('.');
  return labels.length > 1 && labels.every(label =>
    label.length > 0 && label.length <= 63 && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label)
  );
}

export async function isEmailGloballySuppressed(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!isValidOutreachEmail(normalizedEmail)) return false;
  const { rows } = await database.query(
    'SELECT 1 FROM contacts WHERE lower(email) = $1 AND is_suppressed = true LIMIT 1',
    [normalizedEmail]
  );
  return rows.length > 0;
}

export function approvalBlocker(draft) {
  if (draft?.status !== 'APPROVAL_REQUIRED' || !draft?.validation_passed) {
    return 'Only a validated draft awaiting human approval can be approved.';
  }
  const contact = draft.contacts || draft.contact || null;
  if (!contact || contact.verification_status !== 'VERIFIED' || contact.is_suppressed || contact.email !== draft.recipient_email || !isValidOutreachEmail(draft.recipient_email)) {
    return 'Approval requires the persisted verified, unsuppressed contact that owns a valid recipient address.';
  }
  return null;
}

export function smtpAcceptedByServer(sendResult, recipient) {
  if (!recipient || !sendResult?.response) return false;
  const responseCode = Number(String(sendResult.response).match(/^\s*(\d{3})\b/)?.[1]);
  if (!Number.isInteger(responseCode) || responseCode < 200 || responseCode >= 300) return false;
  return (sendResult.accepted || []).some(address =>
    String(address).trim().toLowerCase() === String(recipient).trim().toLowerCase()
  );
}

export function followUpStatusAfterDraft({ draftCreated = false, smtpAccepted = false } = {}) {
  if (smtpAccepted) return 'SENT';
  if (draftCreated) return 'DRAFTED';
  return 'WAITING';
}

export function suppressionUpdateBlocker(requestedSuppressed) {
  return requestedSuppressed === true
    ? null
    : 'Suppression cannot be cleared through this endpoint; unsubscribe and suppressed contacts remain excluded from outreach.';
}
