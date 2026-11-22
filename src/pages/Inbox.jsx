import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Inbox as InboxIcon, RefreshCw, Loader2, Server, PlusCircle, CheckCircle, AlertTriangle } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';

const INTENT_COLORS = {
  INTERESTED: 'emerald',
  PRICE_REQUEST: 'emerald',
  QUOTE_REQUEST: 'emerald',
  PRODUCT_REQUEST: 'sky',
  CATALOG_REQUEST: 'sky',
  SAMPLE_REQUEST: 'sky',
  MEETING_REQUEST: 'violet',
  NEGOTIATION: 'amber',
  QUESTION: 'sky',
  FOLLOW_UP_REQUIRED: 'amber',
  NOT_INTERESTED: 'slate',
  UNSUBSCRIBE: 'red',
  COMPLAINT: 'red',
  WRONG_RECIPIENT: 'slate',
  OUT_OF_OFFICE: 'slate',
  UNKNOWN: 'slate'
};

export default function Inbox() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [hostingerStatus, setHostingerStatus] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState(null);

  const [senderEmail, setSenderEmail] = useState('');
  const [senderName, setSenderName] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [importingReply, setImportingReply] = useState(false);
  const [importFeedback, setImportFeedback] = useState(null);
  const [ambiguousCandidates, setAmbiguousCandidates] = useState([]);
  const [selectedOutreachId, setSelectedOutreachId] = useState('');

  const fetchInbox = async () => {
    setLoading(true);
    try {
      const [mRes, hRes] = await Promise.all([apiFetch('/api/inbox'), apiFetch('/api/hostinger')]);
      const mJson = await mRes.json();
      setMessages(Array.isArray(mJson) ? mJson : mJson?.data || []);
      setHostingerStatus(await hRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInbox(); }, []);

  const syncInbox = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await apiFetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: user?.email })
      });
      const json = await res.json();
      setSyncResult(json);
      await fetchInbox();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleManualReplyImport = async (e) => {
    e.preventDefault();
    setImportingReply(true);
    setImportFeedback(null);
    setError(null);
    try {
      const res = await apiFetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'IMPORT_MANUAL_REPLY',
          payload: {
            senderEmail,
            senderName,
            subject: replySubject,
            bodyText: replyBody,
            receivedAt: receivedAt || undefined,
            selectedOutreachId: selectedOutreachId ? Number(selectedOutreachId) : undefined
          }
        })
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === 'AMBIGUOUS_OUTREACH_MATCH' && Array.isArray(json.candidates)) {
          setAmbiguousCandidates(json.candidates);
          setImportFeedback({
            type: 'ambiguous',
            text: json.error || 'Multiple candidate outreach threads match this reply. Select the matching thread below and submit again.'
          });
          return;
        }
        throw new Error(json.error || 'Could not import manual reply.');
      }

      setAmbiguousCandidates([]);
      setSelectedOutreachId('');
      setSenderEmail('');
      setSenderName('');
      setReplySubject('');
      setReplyBody('');
      setReceivedAt('');
      setImportFeedback({
        type: 'success',
        text: `Reply imported and classified as ${json.intent}.${json.associatedOutreachId ? ` Linked to outreach #${json.associatedOutreachId} (marked REPLIED & follow-ups stopped).` : ''}${json.leadCreated ? ' Commercial lead created.' : ''}`
      });
      await fetchInbox();
    } catch (err) {
      if (err.payload?.code === 'AMBIGUOUS_OUTREACH_MATCH' && Array.isArray(err.payload.candidates)) {
        setAmbiguousCandidates(err.payload.candidates);
        setImportFeedback({
          type: 'ambiguous',
          text: err.payload.error || 'Multiple candidate outreach threads match this reply. Select the matching thread below and submit again.'
        });
      } else {
        setImportFeedback({
          type: 'error',
          text: err.message
        });
      }
    } finally {
      setImportingReply(false);
    }
  };

  return (
    <>
      <Topbar
        title="Hostinger Inbox Monitor"
        subtitle="IMAP-synced incoming communications with intent classification and entity extraction."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <button onClick={syncInbox} disabled={syncing} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-2">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync IMAP
          </button>
        }
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {hostingerStatus && (
          <div className={`mb-4 p-3 rounded-xl text-sm border ${
            hostingerStatus.status === 'CONNECTED' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' :
            'bg-amber-500/10 border-amber-500/30 text-amber-200'
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Server className="w-4 h-4 inline mr-2" />
                <strong>Email Mode:</strong> {hostingerStatus.emailMode || 'MANUAL GMAIL MODE'} · <strong>IMAP Status:</strong> {hostingerStatus.status} · {hostingerStatus.host ? `${hostingerStatus.host}:${hostingerStatus.port}` : 'Not configured'}
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500 text-[#070b16]">
                {hostingerStatus.emailMode || 'MANUAL GMAIL MODE'}
              </span>
            </div>
          </div>
        )}

        {syncResult && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${
            syncResult.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30' :
            syncResult.status === 'NOT CONFIGURED' ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30' :
            'bg-rose-500/10 text-rose-200 border border-rose-500/30'
          }`}>
            Sync: {syncResult.status} · {syncResult.synced || 0} new messages · {syncResult.reason || syncResult.error || 'OK'}
          </div>
        )}

        <form onSubmit={handleManualReplyImport} className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-6 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-amber-50 font-medium flex items-center gap-2">
              <PlusCircle className="w-4 h-4 text-amber-400" /> Manual Reply Import (No-Cost Gmail Fallback)
            </h3>
            <span className="text-xs text-amber-200/60">Admin-only · AI intent classification &amp; CRM logging</span>
          </div>
          <p className="text-xs text-amber-200/60 mb-4">
            Paste an incoming email reply from your Gmail inbox. The system validates the sender, links the reply to the matching outreach thread (or prompts you to choose if ambiguous), runs reply analysis, stops follow-ups, and logs CRM history.
          </p>

          {importFeedback && (
            <div className={`mb-4 p-3 rounded-xl text-xs flex items-start gap-2 border ${
              importFeedback.type === 'success'
                ? 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30'
                : importFeedback.type === 'ambiguous'
                  ? 'bg-amber-500/10 text-amber-200 border-amber-500/30'
                  : 'bg-rose-500/10 text-rose-200 border-rose-500/30'
            }`}>
              {importFeedback.type === 'success' ? (
                <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              )}
              <div>{importFeedback.text}</div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <input
              type="text"
              value={senderEmail}
              onChange={e => { setSenderEmail(e.target.value); setAmbiguousCandidates([]); setSelectedOutreachId(''); }}
              placeholder="Sender Email (e.g. buyer@company.com)"
              required
              className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
            <input
              type="text"
              value={senderName}
              onChange={e => setSenderName(e.target.value)}
              placeholder="Sender Name (optional)"
              className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
            <input
              type="datetime-local"
              value={receivedAt}
              onChange={e => setReceivedAt(e.target.value)}
              title="Received Date & Time (defaults to current time if left blank)"
              className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
          </div>
          <div className="mb-3">
            <input
              type="text"
              value={replySubject}
              onChange={e => { setReplySubject(e.target.value); setAmbiguousCandidates([]); setSelectedOutreachId(''); }}
              placeholder="Incoming Reply Subject (e.g. Re: Sourcing inquiry: Synthetic Resin)"
              required
              className="w-full bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
          </div>
          <div className="mb-3">
            <textarea
              rows={4}
              value={replyBody}
              onChange={e => setReplyBody(e.target.value)}
              placeholder="Paste the incoming email body text here…"
              required
              className="w-full bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
          </div>

          {ambiguousCandidates.length > 0 && (
            <div className="mb-4 p-4 rounded-xl bg-[#070b16] border border-amber-500/40">
              <label className="block text-xs font-semibold text-amber-200 mb-2">
                Ambiguous Thread Match — Select the Outreach Thread to Associate:
              </label>
              <select
                value={selectedOutreachId}
                onChange={e => setSelectedOutreachId(e.target.value)}
                required
                className="w-full bg-[#0e1424] border border-amber-500/30 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
              >
                <option value="">Select matching outreach thread…</option>
                {ambiguousCandidates.map(cand => (
                  <option key={cand.outreachId} value={cand.outreachId}>
                    #{cand.outreachId} · {cand.companyName || 'Company'} · {cand.recipientEmail} · &ldquo;{cand.subject}&rdquo; ({cand.status})
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={importingReply || (ambiguousCandidates.length > 0 && !selectedOutreachId)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center gap-2"
          >
            {importingReply ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
            {importingReply
              ? 'Importing & Classifying Reply…'
              : ambiguousCandidates.length > 0
                ? 'Confirm Thread Selection & Import Reply'
                : 'Import & Analyze Reply'}
          </button>
        </form>

        {loading ? <LoadingState /> : messages.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="NO INBOX MESSAGES"
            description="Once Hostinger IMAP is configured and prospects reply to your outreach, messages will appear here with auto-classified intent and extracted entities."
          />
        ) : (
          <div className="space-y-3">
            {messages.map(m => (
              <div key={m.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="text-amber-50 font-medium">{m.subject}</h4>
                    <div className="text-amber-200/60 text-xs mt-1">From: {m.sender_email} · {formatDate(m.received_at)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Pill label={m.intent} color={INTENT_COLORS[m.intent] || 'slate'} />
                  </div>
                </div>
                <div className="text-sm text-amber-100/80 mt-3 p-3 bg-[#070b16] rounded-lg border border-amber-500/10 max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {m.body_text}
                </div>
                {m.extracted_entities && Object.keys(m.extracted_entities).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-amber-500/10">
                    <div className="text-[10px] text-amber-200/50 uppercase tracking-wider mb-2">Extracted Entities</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      {m.extracted_entities.quantity && (
                        <div><div className="text-amber-200/50 text-[10px]">Quantity</div><div className="text-amber-100">{m.extracted_entities.quantity}</div></div>
                      )}
                      {m.extracted_entities.timeline && (
                        <div><div className="text-amber-200/50 text-[10px]">Timeline</div><div className="text-amber-100">{m.extracted_entities.timeline}</div></div>
                      )}
                      {m.extracted_entities.urgency && (
                        <div><div className="text-amber-200/50 text-[10px]">Urgency</div><div className="text-amber-100">{m.extracted_entities.urgency}</div></div>
                      )}
                      {m.extracted_entities.price_request !== undefined && (
                        <div><div className="text-amber-200/50 text-[10px]">Price Request</div><div className="text-amber-100">{m.extracted_entities.price_request ? 'YES' : 'NO'}</div></div>
                      )}
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
