import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Shield, Activity } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, formatDate } from '../components/UI';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Reports() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { role } = useAuth();
  const [auditLogs, setAuditLogs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (role !== 'admin') return;

    Promise.all([
      apiFetch('/api/admin?section=audit').then(r => r.json()),
      apiFetch('/api/supervisor').then(r => r.json())
    ]).then(([a, s]) => {
      setAuditLogs(Array.isArray(a) ? a : a?.data || []);
      setRuns(Array.isArray(s?.recentRuns) ? s.recentRuns : []);
    }).catch(err => setError(err.message)).finally(() => setLoading(false));
  }, [role]);

  if (role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <>
      <Topbar
        title="Audit & Reports"
        subtitle="Complete audit trail and agent execution history. Every action is logged with timestamp."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8 space-y-6">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <h3 className="text-amber-50 font-medium mb-4 flex items-center gap-2"><Shield className="w-4 h-4" /> Audit Log</h3>
          {loading ? <LoadingState /> : auditLogs.length === 0 ? (
            <EmptyState
              icon={Shield}
              title="NO AUDIT ENTRIES"
              description="Audit logs are created automatically for every dataset upload, research action, email approval and Hostinger send."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-amber-200/60 text-xs uppercase border-b border-amber-500/10">
                    <th className="text-left py-2">Timestamp</th>
                    <th className="text-left py-2">User</th>
                    <th className="text-left py-2">Action</th>
                    <th className="text-left py-2">Entity</th>
                    <th className="text-left py-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.slice(0, 50).map(l => (
                    <tr key={l.id} className="border-b border-amber-500/5">
                      <td className="py-2 text-amber-100 text-xs">{formatDate(l.created_at)}</td>
                      <td className="py-2 text-amber-100 text-xs">{l.user_email}</td>
                      <td className="py-2"><Pill label={l.action} color="amber" /></td>
                      <td className="py-2 text-amber-200/60 text-xs">{l.entity_type}</td>
                      <td className="py-2 text-amber-200/50 text-xs font-mono">{JSON.stringify(l.details).substring(0, 80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <h3 className="text-amber-50 font-medium mb-4 flex items-center gap-2"><Activity className="w-4 h-4" /> Agent Execution History</h3>
          {runs.length === 0 ? (
            <p className="text-amber-200/50 text-sm">No agent runs recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {runs.map(r => (
                <div key={r.id} className="border border-amber-500/10 rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-amber-50 text-sm font-medium">{r.agent_name}</span>
                      <span className="text-amber-200/40 text-xs ml-3">{formatDate(r.started_at)}</span>
                    </div>
                    <Pill label={r.status} color={r.status === 'COMPLETED' ? 'emerald' : r.status === 'FAILED' ? 'red' : 'amber'} />
                  </div>
                  <div className="text-xs text-amber-200/60 mt-1">{r.summary}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
