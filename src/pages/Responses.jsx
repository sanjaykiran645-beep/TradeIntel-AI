import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { MessageSquare, Send, Loader2, ShieldAlert } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';

export default function Responses() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [message, setMessage] = useState(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [mRes, dRes] = await Promise.all([apiFetch('/api/inbox'), apiFetch('/api/responses')]);
      const [mJson, dJson] = await Promise.all([mRes.json(), dRes.json()]);
      setMessages(Array.isArray(mJson) ? mJson : mJson?.data || []);
      setDrafts(Array.isArray(dJson) ? dJson : dJson?.data || []);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const generateDraft = async (msgId, mode = 'SUPERVISED') => {
    setGenerating(msgId);
    setMessage(null);
    try {
      await apiFetch('/api/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inboxMessageId: msgId, mode, userEmail: user?.email })
      });
      await fetchAll();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
    finally { setGenerating(null); }
  };

  const approveDraft = async (id) => {
    try {
      await apiFetch('/api/responses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          action: 'APPROVE',
          editedBody: editBody,
          userEmail: user?.email
        })
      });
      setEditingId(null);
      setEditBody('');
      await fetchAll();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const sendDraft = async (id) => {
    setSendingId(id);
    setMessage(null);
    try {
      const response = await apiFetch('/api/response-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: String(id) })
      });
      const result = await response.json();
      if (result.send_state === 'SENT') {
        setMessage({ type: 'success', text: 'SMTP confirmed acceptance of the approved reply.' });
      } else if (result.send_state === 'FAILED') {
        setMessage({ type: 'error', text: `SMTP confirmed non-acceptance. This attempt is safely retryable. ${result.send_error || ''}`.trim() });
      } else {
        setMessage({ type: 'warning', text: 'SMTP acceptance is uncertain. This draft is blocked pending manual reconciliation. Do not retry.' });
      }
      await fetchAll();
    } catch (err) {
      setMessage({
        type: 'error',
        text: `${err.message} Check the draft status before trying again; SENDING or UNKNOWN attempts must not be retried.`
      });
      await fetchAll();
    } finally {
      setSendingId(null);
    }
  };

  const draftForMessage = (msgId) => drafts.find(d => d.inbox_message_id === msgId);

  const messagesWithoutDrafts = messages.filter(m => !draftForMessage(m.id));

  return (
    <>
      <Topbar
        title="Response Generation"
        subtitle="Drafts are generated from verified intelligence only. Commercial commitments require HUMAN REVIEW."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        {message && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30' : message.type === 'warning' ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30' : 'bg-rose-500/10 text-rose-200 border border-rose-500/30'}`}>
            {message.text}
          </div>
        )}

        {loading ? <LoadingState /> : messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="NO INCOMING MESSAGES"
            description="When prospects reply, they appear here. The Response Agent drafts a verified, supervised reply that you can edit, approve, or reject."
          />
        ) : (
          <div className="space-y-4">
            <h3 className="text-amber-50 font-medium text-lg">Awaiting Reply Drafting</h3>
            {messagesWithoutDrafts.length === 0 ? (
              <p className="text-amber-200/50 text-sm">All messages have response drafts pending review.</p>
            ) : (
              messagesWithoutDrafts.map(m => (
                <div key={m.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="text-amber-50 font-medium">{m.subject}</h4>
                      <div className="text-amber-200/60 text-xs mt-1">From: {m.sender_email}</div>
                    </div>
                    <Pill label={m.intent} color="amber" />
                  </div>
                  <div className="text-sm text-amber-100/80 mt-2 p-3 bg-[#070b16] rounded-lg border border-amber-500/10 max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {m.body_text}
                  </div>
                  <button
                    onClick={() => generateDraft(m.id)}
                    disabled={generating === m.id}
                    className="mt-3 px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-xs flex items-center gap-2"
                  >
                    {generating === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
                    Generate Response Draft
                  </button>
                </div>
              ))
            )}

            {drafts.length > 0 && (
              <>
                <h3 className="text-amber-50 font-medium text-lg mt-8 pt-6 border-t border-amber-500/10">Response Drafts</h3>
                {drafts.map(d => (
                  <div key={d.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h4 className="text-amber-50 font-medium">{d.subject}</h4>
                        <div className="text-amber-200/60 text-xs mt-1">→ {d.recipient_email} · {formatDate(d.created_at)}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Pill label={`Approval: ${d.status}`} color={d.status === 'APPROVED' ? 'emerald' : d.status === 'REJECTED' ? 'red' : 'amber'} />
                        <Pill
                          label={`Send: ${d.send_state || 'UNAVAILABLE'}`}
                          color={d.send_state === 'SENT' ? 'emerald' : ['FAILED', 'UNKNOWN'].includes(d.send_state) ? 'red' : d.send_state === 'SENDING' ? 'amber' : 'slate'}
                        />
                        <Pill label={d.mode} color="slate" />
                      </div>
                    </div>
                    {d.requires_human_review && (
                      <div className="mt-2 bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-lg flex items-start gap-2 text-xs">
                        <ShieldAlert className="w-4 h-4 mt-0.5" />
                        <div>
                          <strong>HUMAN REVIEW REQUIRED</strong>
                          <ul className="mt-1 list-disc list-inside opacity-80">
                            {(d.review_reasons || []).map((r, i) => <li key={i}>{r}</li>)}
                          </ul>
                        </div>
                      </div>
                    )}
                    {d.send_error && (
                      <div className={`mt-2 p-3 rounded-lg text-xs ${d.send_state === 'UNKNOWN' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-200' : 'bg-rose-500/10 border border-rose-500/30 text-rose-200'}`}>
                        Outcome detail: {d.send_error}
                      </div>
                    )}
                    {d.send_state === 'SENT' && (
                      <div className="mt-2 text-emerald-200/80 text-xs">SMTP acceptance is recorded; delivery is not confirmed by this status.</div>
                    )}
                    {['SENDING', 'UNKNOWN'].includes(d.send_state) && (
                      <div className="mt-2 p-3 rounded-lg text-xs bg-amber-500/10 border border-amber-500/30 text-amber-200">
                        This attempt is blocked pending manual reconciliation. Time elapsed alone does not make it safe to retry.
                      </div>
                    )}
                    {d.status === 'APPROVED' && ['NOT_SENT', 'FAILED'].includes(d.send_state) && (
                      <button
                        onClick={() => sendDraft(d.id)}
                        disabled={sendingId === d.id}
                        className="mt-3 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-200 rounded-lg text-xs flex items-center gap-2"
                      >
                        {sendingId === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        {sendingId === d.id ? 'Sending…' : d.send_state === 'FAILED' ? 'Retry confirmed rejection' : 'Send approved reply'}
                      </button>
                    )}
                    {!d.send_state && d.status === 'APPROVED' && (
                      <div className="mt-3 text-amber-200/70 text-xs">Sending is unavailable until reply-send schema is applied.</div>
                    )}
                    {editingId === d.id ? (
                      <textarea
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        className="mt-3 w-full bg-[#070b16] border border-amber-500/20 rounded-lg p-3 text-amber-50 text-sm focus:outline-none"
                        rows={10}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap font-sans text-amber-100/80 bg-[#070b16] p-3 rounded-lg border border-amber-500/10 text-sm mt-3">{d.body_text}</pre>
                    )}
                    {d.status === 'PENDING_APPROVAL' && (
                      <div className="flex gap-2 mt-3">
                        {editingId === d.id ? (
                          <>
                            <button onClick={() => approveDraft(d.id)} className="px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 rounded text-xs flex items-center gap-1">
                              <Send className="w-3 h-3" /> Save & Approve
                            </button>
                            <button onClick={() => { setEditingId(null); setEditBody(''); }} className="px-4 py-2 bg-amber-500/10 text-amber-200 rounded text-xs">Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingId(d.id); setEditBody(d.body_text); }} className="px-4 py-2 bg-sky-500/20 hover:bg-sky-500/30 text-sky-200 rounded text-xs">Edit</button>
                            <button onClick={() => approveDraft(d.id)} className="px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 rounded text-xs flex items-center gap-1">
                              <Send className="w-3 h-3" /> Approve
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
