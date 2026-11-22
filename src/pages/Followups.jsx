import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Repeat, Play, Pause, Loader2, CheckCircle, XCircle } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';

export default function Followups() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const fetchQueue = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/followup');
      const json = await res.json();
      setQueue(Array.isArray(json) ? json : json?.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchQueue(); }, []);

  const processQueue = async () => {
    setProcessing(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: user?.email })
      });
      setResult(await res.json());
      await fetchQueue();
    } catch (err) {
      setError(err.message);
    } finally { setProcessing(false); }
  };

  const stopFollowup = async (id) => {
    try {
      await apiFetch('/api/followup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reason: 'Stopped by operator' })
      });
      await fetchQueue();
    } catch (err) {
      setError(err.message);
    }
  };

  const waiting = queue.filter(q => q.status === 'WAITING');
  const completed = queue.filter(q => q.status !== 'WAITING');

  return (
    <>
      <Topbar
        title="Follow-up Cadence Engine"
        subtitle="INITIAL → WAIT → FOLLOW-UP 1 → WAIT → FOLLOW-UP 2 → STOP. Auto-stops on reply, bounce, unsubscribe, or human action."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <button onClick={processQueue} disabled={processing} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-2">
            {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Process Queue Cycle
          </button>
        }
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {result && (
          <div className="mb-4 p-3 rounded-xl text-sm bg-emerald-500/10 text-emerald-200 border border-emerald-500/30">
            Cycle complete: {result.draftsCreated} follow-up drafts created, {result.stopped} stopped.
          </div>
        )}

        {loading ? <LoadingState /> : queue.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="NO FOLLOW-UPS QUEUED"
            description="Follow-up cycles are automatically scheduled after each verified Hostinger send. Cadence: 3 days → 4 days → STOP."
          />
        ) : (
          <>
            <h3 className="text-amber-50 font-medium mb-3">Waiting Queue ({waiting.length})</h3>
            <div className="space-y-2 mb-8">
              {waiting.length === 0 && <p className="text-amber-200/50 text-sm">No follow-ups pending.</p>}
              {waiting.map(q => (
                <div key={q.id} className="bg-[#0e1424] border border-amber-500/10 rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="text-amber-50 font-medium">{q.companies?.name || 'Unknown'}</div>
                    <div className="text-amber-200/60 text-xs mt-1">
                      Step {q.sequence_step} → {Number(q.sequence_step) + 1} · Scheduled: {formatDate(q.scheduled_for)} · {q.contacts?.email || 'No contact'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill label="WAITING" color="amber" />
                    <button onClick={() => stopFollowup(q.id)} className="p-2 text-rose-300 hover:bg-rose-500/10 rounded">
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <h3 className="text-amber-50 font-medium mb-3">Completed / Stopped ({completed.length})</h3>
            <div className="space-y-2">
              {completed.length === 0 && <p className="text-amber-200/50 text-sm">No history yet.</p>}
              {completed.map(q => (
                <div key={q.id} className="bg-[#0e1424] border border-amber-500/5 rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-amber-50 font-medium">{q.companies?.name || 'Unknown'}</div>
                      <div className="text-amber-200/60 text-xs mt-1">Step {q.sequence_step}</div>
                      {q.reason_stopped && <div className="text-rose-300 text-xs mt-1">{q.reason_stopped}</div>}
                    </div>
                    <Pill label={q.status.replace(/_/g, ' ')} color={q.status === 'SENT' ? 'emerald' : 'slate'} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
