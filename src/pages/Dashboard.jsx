import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Database, Building2, Users, Mail, Target, Activity, Sparkles, AlertCircle, Package, Map } from 'lucide-react';
import Topbar from '../components/Topbar';
import { StatCard, Pill, EmptyState, formatDate, LoadingState, ErrorBanner } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [runningCycle, setRunningCycle] = useState(false);
  const { user } = useAuth();
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};

  const fetchDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const dRes = await apiFetch('/api/dashboard');
      const dJson = await dRes.json();
      setData(dJson);
      try {
        const pRes = await apiFetch('/api/supervisor');
        setPipeline(await pRes.json());
      } catch (supervisorError) {
        setPipeline(null);
        setError(`Supervisor: ${supervisorError.message}`);
      }
    } catch (err) {
      setPipeline(null);
      setError(`${err.code ? `${err.code}: ` : ''}${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDashboard(); }, []);

  const triggerCycle = async (stage) => {
    if (runningCycle) return;
    setRunningCycle(true);
    setError(null);
    try {
      if (!pipeline?.latestDatasetId) {
        throw new Error('Upload a dataset before starting the pipeline.');
      }
      const response = await apiFetch('/api/supervisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_id: pipeline.latestDatasetId, targetStage: stage, retry: true, userEmail: user?.email })
      });
      const result = await response.json();
      await fetchDashboard();
      if (result?.success !== true) {
        setError(`Pipeline ${result?.status || 'FAILED'}: ${result?.pipeline?.error?.message || result?.error || 'One or more required stages did not complete.'}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRunningCycle(false);
    }
  };

  if (loading) {
    return (
      <>
        <Topbar title="Mission Control" subtitle="Persisted trade intelligence, qualification, and outreach status." mobileSidebarOpen={mobileSidebarOpen} setMobileSidebarOpen={setMobileSidebarOpen} />
        <div className="p-8"><LoadingState label="Loading real intelligence from database…" /></div>
      </>
    );
  }

  const m = data?.metrics || {};
  const hostinger = data?.hostingerIntegration || {};
  const intelligence = data?.intelligence || {};

  return (
    <>
      <Topbar
        title="Mission Control"
        subtitle="Persisted trade intelligence, qualification, and outreach status."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <button
            onClick={() => triggerCycle('SUPERVISOR')}
            disabled={!pipeline?.latestDatasetId || runningCycle}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-2"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Run Pipeline Cycle
          </button>
        }
      />
      <div className="p-4 lg:p-8 space-y-6">
        <ErrorBanner error={error} onClose={() => setError(null)} />

        {!error && data && !data.hasData && (
          <EmptyState
            icon={AlertCircle}
            title="NO BUSINESS DATA AVAILABLE"
            description="No persisted dataset is available yet. Upload a trade CSV / XLSX / JSON file to begin analysis."
          />
        )}

        {data && (
          <>
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <StatCard label="Datasets" value={m.datasets} sublabel="Persisted trade files" icon={Database} accent="amber" />
            <StatCard label="Companies" value={m.companies} sublabel="Distinct entities" icon={Building2} accent="sky" />
            <StatCard label="Products" value={m.products} sublabel="Trade items" icon={Package} accent="emerald" />
            <StatCard label="Markets" value={m.markets} sublabel="Persisted markets" icon={Map} accent="sky" />
            <StatCard label="Qualified Leads" value={m.qualifiedLeads} sublabel={`${m.historicalLegacyLeads || 0} historical / legacy excluded`} icon={Target} accent="emerald" />
            <StatCard label="Pitch Previews" value={m.emailPreviews} sublabel="Persisted, non-sendable drafts" icon={Mail} accent="violet" />
            <StatCard label="Contacts" value={m.contacts} sublabel="Stored business contacts" icon={Users} accent="violet" />
            <StatCard label="Sent Emails" value={m.emailsSent} sublabel={`${m.emailsGenerated} outreach records`} icon={Mail} accent="amber" />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-amber-50 font-medium">Hostinger SMTP / IMAP Configuration</h3>
              <Pill label={hostinger.configured ? 'CONFIGURED' : 'NOT CONFIGURED'} color={hostinger.configured ? 'amber' : 'red'} />
            </div>
            {hostinger.configured ? (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between border-b border-amber-500/5 pb-2">
                  <span className="text-amber-200/60">SMTP Host</span>
                  <span className="text-amber-100 font-mono">{hostinger.host}</span>
                </div>
                <div className="flex justify-between border-b border-amber-500/5 pb-2">
                  <span className="text-amber-200/60">Outgoing (SMTP)</span>
                  <span className="text-amber-300 font-medium">CONFIGURED · send confirmation is recorded per email</span>
                </div>
                <div className="flex justify-between border-b border-amber-500/5 pb-2">
                  <span className="text-amber-200/60">Incoming (IMAP)</span>
                  <span className="text-amber-300 font-medium">CONFIGURED · replies appear after IMAP sync</span>
                </div>
              </div>
            ) : (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-rose-200 text-sm">
                Hostinger SMTP/IMAP integration is <strong>NOT CONFIGURED</strong>. No emails will be transmitted until credentials are added in Admin Settings.
              </div>
            )}
          </div>

          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
            <h3 className="text-amber-50 font-medium mb-4">Potential Distribution</h3>
            <div className="space-y-2">
              {Object.entries(data?.potentialDistribution || {}).map(([k, v]) => {
                const max = Math.max(1, ...Object.values(data?.potentialDistribution || { 0: 1 }));
                const w = (v / max) * 100;
                const colors = {
                  VERY_HIGH: 'bg-emerald-400',
                  HIGH: 'bg-amber-400',
                  MEDIUM: 'bg-sky-400',
                  LOW: 'bg-slate-400',
                  INSUFFICIENT_DATA: 'bg-rose-400'
                };
                return (
                  <div key={k}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-amber-200/70">{k.replace(/_/g, ' ')}</span>
                      <span className="text-amber-100">{v}</span>
                    </div>
                    <div className="h-2 bg-[#070b16] rounded-full overflow-hidden">
                      <div className={`h-full ${colors[k] || 'bg-slate-400'}`} style={{ width: `${w}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
            <h3 className="text-amber-50 font-medium mb-3">Trade Activity</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between gap-3 text-amber-200/70">
                <span>Source rows</span>
                <span className="text-amber-100">{Number(m.rawRecords || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-3 text-amber-200/70">
                <span>Normalized rows</span>
                <span className="text-amber-100">{Number(m.normalizedRecords || 0).toLocaleString()}</span>
              </div>
              {(intelligence.tradeValueByCurrency || []).slice(0, 5).map(item => (
                <div key={item.currency} className="flex justify-between gap-3 text-amber-200/70">
                  <span>{item.currency} value</span>
                  <span className="text-amber-100">{Number(item.totalValue).toLocaleString()}</span>
                </div>
              ))}
              {(intelligence.tradeQuantityByUnit || []).slice(0, 3).map(item => (
                <div key={item.unit} className="flex justify-between gap-3 text-amber-200/70">
                  <span>Quantity ({item.unit})</span>
                  <span className="text-amber-100">{Number(item.totalQuantity).toLocaleString()}</span>
                </div>
              ))}
              {!(intelligence.tradeValueByCurrency || []).length && (
                <div className="text-amber-200/50">No persisted trade totals.</div>
              )}
            </div>
          </div>
          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
            <h3 className="text-amber-50 font-medium mb-3">Top Markets & Products</h3>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="space-y-2">
                <div className="text-amber-300">Markets</div>
                {(intelligence.topMarkets || []).slice(0, 5).map(item => (
                  <div key={item.country} className="text-amber-200/70">
                    {item.country} · {Number(item.companies).toLocaleString()} companies
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <div className="text-amber-300">Products</div>
                {(intelligence.topProducts || []).slice(0, 5).map(item => (
                  <div key={`${item.product}-${item.category}`} className="text-amber-200/70">
                    {item.product} · {Number(item.frequency).toLocaleString()} trades
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
            <h3 className="text-amber-50 font-medium mb-3">Score Evidence & Safety</h3>
            <div className="space-y-2 text-xs text-amber-200/70">
              <div>Average score: <span className="text-amber-100">{Number(intelligence.average_score || 0).toFixed(2)}</span></div>
              <div>Evidence coverage: <span className="text-amber-100">{Number(intelligence.average_evidence_coverage || 0).toFixed(0)}%</span></div>
              <div>Supplier diversification avg: <span className="text-amber-100">{Number(intelligence.average_supplier_diversification || 0).toFixed(2)}</span></div>
              <div>Growth: <span className="text-amber-100">{Number(intelligence.growth_unavailable_count || 0)} unavailable</span></div>
              <div>Engagement: <span className="text-amber-100">{Number(intelligence.engagement_unavailable_count || 0)} unavailable</span></div>
              <div>Verified contacts: <span className="text-amber-100">{Number(intelligence.contactAvailability?.verifiedContacts || 0)} · {intelligence.contactAvailability?.status || 'UNAVAILABLE'}</span></div>
              <div>Risk: <span className="text-amber-100">{intelligence.riskSummary?.outreachSafetyLevel || intelligence.riskStatus || 'NOT_RUN'}</span></div>
              <div>Concentration evidence (market / product / IEC supplier): <span className="text-amber-100">
                {intelligence.riskSummary?.concentrationMetrics
                  ? `${intelligence.riskSummary.concentrationMetrics.marketConcentration.status} / ${intelligence.riskSummary.concentrationMetrics.productConcentration.status} / ${intelligence.riskSummary.concentrationMetrics.supplierConcentration.status}`
                  : 'UNAVAILABLE'}
              </span></div>
              <div>Research / contact discovery: <span className="text-amber-100">{intelligence.researchAvailability || intelligence.researchStatus || 'UNAVAILABLE'} / {intelligence.contactDiscoveryStatus || 'NOT_RUN'}</span></div>
              <div>Email previews: <span className="text-amber-100">{Number(intelligence.emailPreviewCount || 0)} · {intelligence.emailDraftStatus || 'NOT_RUN'}</span></div>
              <div>Email sending: <span className="text-amber-100">{intelligence.emailSendingEnabled ? 'ENABLED' : 'OFF'} · {Number(intelligence.emailsSent || 0)} sent</span></div>
            </div>
          </div>
        </div>

        <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-amber-50 font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-amber-400" />
              Pipeline Orchestration
            </h3>
            <span className="text-xs text-amber-200/40 uppercase tracking-widest">Live Status</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {(pipeline?.pipelineStages || []).map(stage => {
              const statusColors = {
                COMPLETED: 'border-emerald-500/30 bg-emerald-500/5',
                RUNNING: 'border-amber-500/30 bg-amber-500/5',
                REVIEW_REQUIRED: 'border-sky-500/30 bg-sky-500/5',
                BLOCKED: 'border-rose-500/30 bg-rose-500/5',
                QUEUED: 'border-slate-500/30 bg-slate-500/5',
                FAILED: 'border-rose-500/30 bg-rose-500/5'
              };
              const statusLabelColors = {
                COMPLETED: 'text-emerald-300',
                RUNNING: 'text-amber-300',
                REVIEW_REQUIRED: 'text-sky-300',
                BLOCKED: 'text-rose-300',
                QUEUED: 'text-slate-300',
                FAILED: 'text-rose-300'
              };
              return (
                <div key={stage.id} className={`border rounded-xl p-4 ${statusColors[stage.status] || statusColors.QUEUED}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-amber-100 text-sm font-medium">{stage.id}</span>
                    <span className={`text-[10px] uppercase tracking-wider ${statusLabelColors[stage.status] || ''}`}>
                      {stage.status}
                    </span>
                  </div>
                  <div className="text-xs text-amber-200/60 leading-relaxed">{stage.name}</div>
                  <div className="text-amber-50 text-2xl font-light mt-3">{stage.recordsProduced ?? stage.items}</div>
                  <div className="text-[10px] text-amber-200/40 uppercase tracking-wider">records produced · {stage.recordsProcessed ?? stage.items} processed</div>
                  {(stage.blocker || stage.reason || stage.error) && (
                    <div className="text-[10px] text-rose-200/80 mt-2 leading-relaxed">{stage.blocker || stage.reason || stage.error?.message || stage.error}</div>
                  )}
                  {stage.completedAt && <div className="text-[9px] text-amber-200/30 mt-2">Updated {formatDate(stage.completedAt)}</div>}
                  {stage.evidence && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-amber-300/70">Persisted evidence</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] text-amber-100/50">{JSON.stringify(stage.evidence, null, 2)}</pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
            <h3 className="text-amber-50 font-medium mb-4">Recent Qualified Leads</h3>
            {(data?.recentLeads || []).length === 0 ? (
              <EmptyState
                icon={Target}
                title="No qualified leads detected"
                description="Company-potential leads use persisted eight-factor scores. Reply-qualified leads appear only after genuine inbox messages."
              />
            ) : (
              <div className="space-y-2">
                {data.recentLeads.map(l => (
                  <div key={l.id} className="border border-amber-500/10 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-amber-100 text-sm font-medium">{l.company_name}</div>
                      <Pill label={l.intent_type} color="emerald" />
                    </div>
                    <div className="text-xs text-amber-200/60">{l.product_requirement}</div>
                    <div className="text-xs text-amber-200/40 mt-1">Score: {l.score}{l.confidence == null ? '' : ` · Confidence: ${(Number(l.confidence) * 100).toFixed(0)}%`}</div>
                    {l.evidence?.source === 'company_potential' && (
                      <div className="text-[10px] text-amber-200/50 mt-1">Potential {l.evidence.potentialCategory} · Product fit {l.evidence.factors?.productFit} · Activity {l.evidence.factors?.activity} · Recency {l.evidence.factors?.recency}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
            <h3 className="text-amber-50 font-medium mb-4">CRM Activity Stream</h3>
            {(data?.recentActivities || []).length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No activity recorded"
                description="Activities appear when data is processed, research is performed, emails are sent, or replies are received."
              />
            ) : (
              <div className="space-y-2">
                {data.recentActivities.map(a => (
                  <div key={a.id} className="border-l-2 border-amber-500/30 pl-3 py-1">
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-amber-100 text-sm">{a.title}</div>
                      <div className="text-[10px] text-amber-200/40 whitespace-nowrap">{formatDate(a.created_at)}</div>
                    </div>
                    <div className="text-xs text-amber-200/60">{a.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
          </>
        )}
      </div>
    </>
  );
}
