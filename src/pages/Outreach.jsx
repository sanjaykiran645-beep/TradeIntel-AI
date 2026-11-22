import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Mail, Send, CheckCircle, AlertCircle, Loader2, ShieldCheck, ExternalLink } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';
import { runUiAction } from '../lib/api-auth-errors';

const STATUS_COLORS = {
  DRAFT: 'slate',
  GENERATED: 'sky',
  VALIDATING: 'amber',
  APPROVAL_REQUIRED: 'amber',
  APPROVED: 'sky',
  OPENED_IN_GMAIL: 'amber',
  MANUALLY_CONFIRMED_SENT: 'emerald',
  QUEUED: 'sky',
  SENDING: 'amber',
  SENT: 'emerald',
  UNKNOWN: 'rose',
  FAILED: 'red',
  REPLIED: 'violet',
  NO_RESPONSE: 'slate',
  FOLLOW_UP_DUE: 'amber',
  COMPLETED: 'emerald'
};

const STATUS_LABELS = {
  DRAFT: 'Draft',
  APPROVAL_REQUIRED: 'Approval Required',
  APPROVED: 'Approved',
  OPENED_IN_GMAIL: 'Opened in Gmail',
  MANUALLY_CONFIRMED_SENT: 'Manually Confirmed Sent',
  SENT: 'Sent (SMTP/API)',
  REPLIED: 'Reply Received',
  SENDING: 'Sending',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown'
};

export default function Outreach() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [emails, setEmails] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [selectedLead, setSelectedLead] = useState('');
  const [selectedContact, setSelectedContact] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sendingId, setSendingId] = useState(null);
  const [openingComposeId, setOpeningComposeId] = useState(null);
  const [confirmingManualId, setConfirmingManualId] = useState(null);
  const [manualConfirmTargetId, setManualConfirmTargetId] = useState(null);
  const [manualOperatorNote, setManualOperatorNote] = useState('');
  const [manualComposeLinks, setManualComposeLinks] = useState({});
  const [uncertainSendIds, setUncertainSendIds] = useState(() => new Set());
  const [message, setMessage] = useState(null);
  const [hostingerStatus, setHostingerStatus] = useState(null);
  const [filter, setFilter] = useState('ALL');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [eRes, cRes, ctRes, hRes, lRes] = await Promise.all([
        apiFetch('/api/email-engine'),
        apiFetch('/api/companies?mode=picker'),
        apiFetch('/api/contacts'),
        apiFetch('/api/hostinger'),
        apiFetch('/api/leads')
      ]);
      const [eJson, cJson, ctJson, hJson, lJson] = await Promise.all([
        eRes.json(),
        cRes.json(),
        ctRes.json(),
        hRes.json(),
        lRes.json()
      ]);
      const emailRows = Array.isArray(eJson) ? eJson : eJson?.data || [];
      setEmails(emailRows);
      setUncertainSendIds(previous => new Set([...previous].filter(id =>
        emailRows.some(email => String(email.id) === id && email.status === 'APPROVED')
      )));
      setCompanies(Array.isArray(cJson) ? cJson : cJson?.data || []);
      setContacts(Array.isArray(ctJson) ? ctJson : ctJson?.data || []);
      setHostingerStatus(hJson);
      setLeads(Array.isArray(lJson) ? lJson : lJson?.data || []);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const handleGenerate = async () => {
    if (!selectedCompany && !selectedLead) return;
    setGenerating(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/email-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: selectedLead ? Number(selectedLead) : undefined,
          companyId: selectedCompany ? Number(selectedCompany) : undefined,
          contactId: selectedContact ? Number(selectedContact) : null
        })
      });
      const json = await res.json();
      if (!res.ok && json.status === 'REVIEW_REQUIRED') {
        setMessage({ type: 'review', text: json.reason || json.error, preview: json.preview || null });
        return;
      }
      if (!res.ok) throw new Error(json.reason || json.error);
      setMessage({ type: 'success', text: `Email generated for ${json.company_name} — awaiting approval.` });
      setSelectedCompany('');
      setSelectedLead('');
      setSelectedContact('');
      await fetchAll();
    } catch (err) {
      if (err.payload?.status === 'REVIEW_REQUIRED') {
        setMessage({ type: 'review', text: err.payload.reason || 'Verified contact required before sending.', preview: err.payload.preview || null });
      } else {
        setMessage({ type: 'error', text: err.message });
      }
    } finally {
      setGenerating(false);
    }
  };

  const approve = async (id) => {
    setMessage(null);
    try {
      await apiFetch('/api/email-engine', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'APPROVE', userEmail: user?.email })
      });
      setMessage({ type: 'success', text: 'Email APPROVED and ready for Hostinger transmission.' });
      await fetchAll();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const reject = async (id) => {
    setMessage(null);
    await runUiAction(async () => {
      await apiFetch('/api/email-engine', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'REJECT' })
      });
      await fetchAll();
    }, message => setMessage({ type: 'error', text: message }));
  };

  const openInGmailCompose = async (id) => {
    setMessage(null);
    setOpeningComposeId(id);
    try {
      const res = await apiFetch('/api/email-engine', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'OPEN_GMAIL_COMPOSE' })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not prepare Gmail compose URL.');
      if (json.composeUrl) {
        setManualComposeLinks(prev => ({ ...prev, [id]: json.composeUrl }));
        window.open(json.composeUrl, '_blank', 'noopener,noreferrer');
      }
      await fetchAll();
      setMessage({
        type: 'warning',
        text: json.notice || 'Gmail compose opened in a new tab. Opening Gmail does NOT mean the email was sent. After you click Send in Gmail, use "Confirm Manually Sent" to record your manual assertion.'
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setOpeningComposeId(null);
    }
  };

  const confirmManuallySent = async (id) => {
    setMessage(null);
    setConfirmingManualId(id);
    try {
      const res = await apiFetch('/api/email-engine', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          action: 'CONFIRM_MANUAL_SENT',
          operatorNote: manualOperatorNote
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not confirm manual send.');
      setManualConfirmTargetId(null);
      setManualOperatorNote('');
      await fetchAll();
      setMessage({
        type: json.warnings?.length ? 'warning' : 'success',
        text: json.warnings?.length
          ? `${json.message} ${json.warnings.join(' ')}`
          : json.message || 'Manually Confirmed Sent recorded as an operator assertion (not independently verified delivery).'
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setConfirmingManualId(null);
    }
  };

  const sendViaHostinger = async (id) => {
    setMessage(null);
    setSendingId(id);
    try {
      const res = await apiFetch('/api/hostinger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outreachId: id, userEmail: user?.email })
      });
      const json = await res.json();
      await fetchAll();
      if (json.send_state !== 'SENT') {
        setUncertainSendIds(previous => new Set(previous).add(String(id)));
        setMessage({ type: 'warning', text: 'The server did not confirm a persisted SENT state. Do not resend until the saved send status has been checked.' });
      } else if (json.warnings?.length) {
        setMessage({
          type: 'warning',
          text: `SMTP accepted the message and SENT state was saved. Do not resend. ${json.warnings.join(' ')}`
        });
      } else {
        setMessage({ type: 'success', text: 'SMTP accepted the message. This confirms acceptance, not delivery.' });
      }
    } catch (err) {
      try { await fetchAll(); } catch { /* preserve the send outcome message */ }
      if (err.payload?.smtpAccepted || err.code === 'NETWORK_ERROR' || ['UNKNOWN', 'PERSISTENCE_FAILED'].includes(err.payload?.status)) {
        setUncertainSendIds(previous => new Set(previous).add(String(id)));
        setMessage({
          type: 'warning',
          text: err.payload?.smtpAccepted
            ? 'SMTP accepted the message, but its SENT state could not be confirmed as saved. Do not resend; reconcile the persisted record.'
            : err.code === 'NETWORK_ERROR'
              ? 'The request response was lost, so the send outcome is unknown. This draft is disabled for now; refresh its saved status and do not retry while it is SENDING, UNKNOWN, or SENT.'
            : 'The SMTP outcome is uncertain or could not be saved. Do not resend; inspect the persisted send status before taking further action.'
        });
      } else {
        setMessage({ type: 'error', text: err.message });
      }
    } finally {
      setSendingId(null);
    }
  };

  const currentLeads = leads.filter(lead => lead.qualification_class !== 'HISTORICAL_LEGACY');
  const filteredEmails = emails.filter(e => filter === 'ALL' || e.status === filter);

  return (
    <>
      <Topbar
        title="Outreach Composer"
        subtitle="Personalized Voyage International Business outreach using verified dataset evidence. Approval-required flow."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        {message && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30' : message.type === 'warning' ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30' : message.type === 'review' ? 'bg-sky-500/10 text-sky-200 border border-sky-500/30' : 'bg-rose-500/10 text-rose-200 border border-rose-500/30'}`}>
            {message.text}
            {message.preview && (
              <div className="mt-3 bg-[#070b16] border border-sky-500/20 rounded-lg p-3">
                <div className="text-xs text-sky-200 mb-2">Non-sendable preview · no recipient assigned</div>
                <div className="text-xs text-amber-100 mb-2"><strong>Subject:</strong> {message.preview.subject}</div>
                <pre className="whitespace-pre-wrap font-sans text-xs text-amber-100/80">{message.preview.bodyText}</pre>
              </div>
            )}
          </div>
        )}

        {hostingerStatus && (
          <div className={`mb-4 p-3 rounded-xl text-sm border ${
            hostingerStatus.status === 'CONNECTED' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' :
            hostingerStatus.status === 'FAILED' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' :
            'bg-amber-500/10 border-amber-500/30 text-amber-200'
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>Email Mode:</strong> {hostingerStatus.emailMode || 'MANUAL GMAIL MODE'} · <strong>Automatic sending:</strong> {hostingerStatus.emailSendingEnabled ? 'ENABLED' : 'DISABLED (EMAIL_SENDING_ENABLED=false)'}
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500 text-[#070b16]">
                {hostingerStatus.emailMode || 'MANUAL GMAIL MODE'}
              </span>
            </div>
            <div className="mt-1 text-xs opacity-85">
              Approved outreach opens in your Gmail compose window for manual review and sending. Opening Gmail does <strong>not</strong> mean the email was sent — confirm manually only after sending in Gmail.
            </div>
          </div>
        )}

        <div className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-6 mb-6">
          <h3 className="text-amber-50 font-medium mb-4">Compose New Outreach</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <select value={selectedLead} onChange={(e) => { setSelectedLead(e.target.value); setSelectedCompany(''); setSelectedContact(''); }} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none">
              <option value="">Select persisted qualified lead (optional)</option>
              {currentLeads.map(l => <option key={l.id} value={l.id}>{l.company_name} · {l.intent_type} · score {l.score}</option>)}
            </select>
            <select value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setSelectedLead(''); setSelectedContact(''); }} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none">
              <option value="">Select company (from dataset)…</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name} — {c.country}</option>)}
            </select>
            <select value={selectedContact} onChange={(e) => setSelectedContact(e.target.value)} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none">
              <option value="">Auto-select verified contact</option>
              {contacts.filter(c => c.verification_status === 'VERIFIED' && !c.is_suppressed && c.company_id === Number(selectedCompany || currentLeads.find(l => String(l.id) === selectedLead)?.company_id || 0)).map(c => (
                <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
              ))}
            </select>
          </div>
          <div className="text-xs text-amber-200/50 mb-3">Drafts use persisted company/product evidence and an existing VERIFIED, unsuppressed contact. A qualified lead without a discovered contact stays in review.</div>
          <button onClick={handleGenerate} disabled={(!selectedCompany && !selectedLead) || generating} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center gap-2">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Generate Personalized Email
          </button>
        </div>

        <div className="flex gap-1 bg-[#0e1424] border border-amber-500/20 rounded-lg p-1 mb-4 overflow-x-auto">
          {['ALL', 'DRAFT', 'APPROVAL_REQUIRED', 'APPROVED', 'OPENED_IN_GMAIL', 'MANUALLY_CONFIRMED_SENT', 'SENT', 'REPLIED', 'FAILED', 'UNKNOWN'].map(s => (
            <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 text-xs rounded whitespace-nowrap ${
              filter === s ? 'bg-amber-500 text-[#070b16] font-semibold' : 'text-amber-200/60 hover:text-amber-100'
            }`}>
              {STATUS_LABELS[s] || s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {loading ? <LoadingState /> : filteredEmails.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="NO OUTREACH YET"
            description="Select a company and generate your first personalized Voyage International Business outreach."
          />
        ) : (
          <div className="space-y-4">
            {filteredEmails.map(e => (
              <div key={e.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="text-amber-50 font-medium">{e.company_name}</h4>
                    <div className="text-amber-200/60 text-xs mt-1">→ {e.recipient_email}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Pill label={STATUS_LABELS[e.status] ? `${STATUS_LABELS[e.status]} (${e.status})` : e.status} color={STATUS_COLORS[e.status] || 'slate'} />
                    {e.message_id && <div className="text-[10px] text-amber-200/40 font-mono">{e.message_id.substring(0, 28)}</div>}
                  </div>
                </div>
                <div className="text-xs text-amber-200/60 mb-2"><strong>Subject:</strong> {e.subject}</div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-amber-300 hover:text-amber-200 mb-2">View body</summary>
                  <pre className="whitespace-pre-wrap font-sans text-amber-100/80 bg-[#070b16] p-3 rounded-lg border border-amber-500/10 text-xs">{e.body_text}</pre>
                </details>
                {e.validation_errors && e.validation_errors.length > 0 && (
                  <div className="mt-2 text-xs text-rose-300">⚠ {e.validation_errors.join(', ')}</div>
                )}
                {e.failed_reason && (
                  <div className="mt-2 text-xs text-rose-300">Failed: {e.failed_reason}</div>
                )}
                {e.status === 'OPENED_IN_GMAIL' && (
                  <div className="mt-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
                    <strong>Opened in Gmail Compose:</strong> Opening Gmail does <strong>not</strong> mean the email was sent. After you click Send in your Gmail tab, click <strong>&ldquo;Confirm Manually Sent&rdquo;</strong> below to record your manual assertion.
                  </div>
                )}
                {e.status === 'SENDING' && (
                  <div className="mt-2 text-xs text-amber-200">This attempt is still active or was interrupted. Verify the provider outcome before taking further action; this draft cannot be resent automatically.</div>
                )}
                {e.status === 'UNKNOWN' && (
                  <div className="mt-2 text-xs text-rose-200">SMTP acceptance is uncertain. Verify provider state before taking further action; this draft remains blocked from sending.</div>
                )}
                <div className="flex gap-2 mt-4 flex-wrap items-center">
                  {e.status === 'APPROVAL_REQUIRED' && (
                    <>
                      <button onClick={() => approve(e.id)} className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 rounded text-xs flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Approve
                      </button>
                      <button onClick={() => reject(e.id)} className="px-3 py-1.5 bg-rose-500/10 text-rose-300 rounded text-xs">
                        Reject
                      </button>
                    </>
                  )}
                  {(e.status === 'APPROVED' || e.status === 'OPENED_IN_GMAIL') && (
                    <>
                      <button
                        onClick={() => openInGmailCompose(e.id)}
                        disabled={openingComposeId !== null || confirmingManualId !== null}
                        className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded text-xs flex items-center gap-1"
                      >
                        {openingComposeId === e.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                        {openingComposeId === e.id ? 'Opening Gmail…' : e.status === 'OPENED_IN_GMAIL' ? 'Re-open in Gmail Compose' : 'Open in Gmail Compose'}
                      </button>
                      {manualComposeLinks[e.id] && (
                        <a
                          href={manualComposeLinks[e.id]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1.5 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/30 rounded text-xs flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" /> Direct Gmail Tab Link
                        </a>
                      )}
                      <button
                        onClick={() => {
                          setManualConfirmTargetId(manualConfirmTargetId === e.id ? null : e.id);
                          setManualOperatorNote('');
                        }}
                        disabled={confirmingManualId !== null}
                        className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-200 border border-emerald-500/30 rounded text-xs flex items-center gap-1"
                      >
                        <CheckCircle className="w-3 h-3" /> Confirm Manually Sent
                      </button>
                    </>
                  )}
                  {e.status === 'APPROVED' && (
                    <button onClick={() => sendViaHostinger(e.id)} disabled={!hostingerStatus?.emailSendingEnabled || sendingId !== null || uncertainSendIds.has(String(e.id))} title={uncertainSendIds.has(String(e.id)) ? 'Outcome is uncertain; refresh and inspect saved status before retrying' : hostingerStatus?.emailSendingEnabled ? 'Send approved email' : 'Outbound email sending is disabled'} className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-amber-200 rounded text-xs flex items-center gap-1">
                      {sendingId === e.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} {sendingId === e.id ? 'Sending…' : 'Send via Hostinger SMTP'}
                    </button>
                  )}
                  {e.status === 'MANUALLY_CONFIRMED_SENT' && (
                    <div className="text-xs text-emerald-300 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" /> Manually Confirmed Sent: {formatDate(e.sent_at)} · Recorded as manual operator assertion (not independently verified delivery)
                    </div>
                  )}
                  {e.status === 'SENT' && (
                    <div className="text-xs text-emerald-300 flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" /> SMTP accepted: {formatDate(e.sent_at)} · delivery not confirmed
                    </div>
                  )}
                  {e.status === 'REPLIED' && (
                    <div className="text-xs text-violet-300 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" /> Reply Received · Follow-up sequence stopped
                    </div>
                  )}
                </div>
                {manualConfirmTargetId === e.id && (e.status === 'APPROVED' || e.status === 'OPENED_IN_GMAIL') && (
                  <div className="mt-4 p-4 rounded-xl bg-[#070b16] border border-emerald-500/30 space-y-3">
                    <div className="text-xs text-emerald-200 font-medium">
                      Manual Send Confirmation Step (Operator Assertion)
                    </div>
                    <p className="text-xs text-amber-200/75">
                      Confirming here records your manual assertion that you reviewed and sent this email to <strong>{e.recipient_email}</strong> in your Gmail compose window. This is stored as a manual assertion (<code className="text-amber-100">deliveryVerified: false</code>), schedules the follow-up sequence, and logs CRM activity.
                    </p>
                    <input
                      type="text"
                      value={manualOperatorNote}
                      onChange={ev => setManualOperatorNote(ev.target.value)}
                      placeholder="Optional note (e.g., Sent from Gmail web compose at 14:30 IST)"
                      className="w-full bg-[#0e1424] border border-amber-500/20 rounded-lg px-3 py-2 text-amber-50 text-xs focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => confirmManuallySent(e.id)}
                        disabled={confirmingManualId === e.id}
                        className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#070b16] font-semibold rounded text-xs flex items-center gap-1"
                      >
                        {confirmingManualId === e.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                        {confirmingManualId === e.id ? 'Recording Assertion…' : 'I Sent This in Gmail — Record Manual Confirmation'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setManualConfirmTargetId(null);
                          setManualOperatorNote('');
                        }}
                        className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 rounded text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
