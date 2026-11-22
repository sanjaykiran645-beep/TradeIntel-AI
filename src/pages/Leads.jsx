import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Target, CheckCircle, XCircle, Loader2, Eye, Mail, Search } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';
import { runUiAction } from '../lib/api-auth-errors';

export default function Leads() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [emailPreview, setEmailPreview] = useState(null);
  const [draftGenerating, setDraftGenerating] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0, current_rule_leads: 0, historical_legacy_leads: 0, commercial_reply_leads: 0 });

  const fetchLeads = async (requestedPage = page) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/leads?page=${requestedPage}&pageSize=20`);
      const result = await res.json();
      const pageLeads = Array.isArray(result) ? result : result.data || [];
      setLeads(pageLeads);
      setPage(requestedPage);
      setPageInfo(Array.isArray(result)
        ? { page: requestedPage, pageSize: 20, total: result.length, totalPages: 1, current_rule_leads: 0, historical_legacy_leads: 0, commercial_reply_leads: 0 }
        : {
            page: result.page,
            pageSize: result.pageSize,
            total: result.total,
            totalPages: result.totalPages,
            current_rule_leads: result.current_rule_leads || 0,
            historical_legacy_leads: result.historical_legacy_leads || 0,
            commercial_reply_leads: result.commercial_reply_leads || 0
          });
      setSelected(current => pageLeads.find(lead => lead.id === current?.id) || pageLeads[0] || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLeads(1); }, []);

  const updateStatus = async (id, status) => {
    setError(null);
    await runUiAction(async () => {
      await apiFetch('/api/leads', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status, userEmail: user?.email })
      });
      await fetchLeads(page);
    }, setError);
  };

  const generatePitchPreview = async () => {
    if (!selected) return;
    setDraftGenerating(true);
    setEmailPreview(null);
    setError(null);
    try {
      const response = await apiFetch('/api/email-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selected.id })
      });
      const draft = await response.json();
      setEmailPreview({ status: 'SENDABLE_DRAFT', draft });
    } catch (err) {
      if (err.payload?.status === 'REVIEW_REQUIRED') {
        setEmailPreview({ status: 'PREVIEW', preview: err.payload.preview || null, reason: err.payload.reason });
        if (err.payload.preview) {
          setSelected(current => current?.id === selected.id
            ? { ...current, evidence: { ...(current.evidence || {}), pitchingEmailPreview: err.payload.preview } }
            : current);
        }
      } else {
        setError(err.message);
      }
    } finally {
      setDraftGenerating(false);
    }
  };

  const displayedEmailPreview = emailPreview || (selected?.evidence?.pitchingEmailPreview
    ? { status: 'PREVIEW', preview: selected.evidence.pitchingEmailPreview, reason: selected.evidence.pitchingEmailPreview.reason }
    : null);

  return (
    <>
      <Topbar
        title="Qualified Leads"
        subtitle="Current company-potential leads use total_score ≥ 75 and at least 10 transactions; legacy records remain labeled for history."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {!loading && pageInfo.total > 0 && (
          <div className="mb-4 text-xs text-amber-200/70">
            {Number(pageInfo.current_rule_leads).toLocaleString()} current-rule leads · {Number(pageInfo.historical_legacy_leads).toLocaleString()} historical / legacy leads retained · {Number(pageInfo.commercial_reply_leads).toLocaleString()} commercial-reply leads
          </div>
        )}
        {loading ? <LoadingState /> : leads.length === 0 ? (
          <EmptyState
            icon={Target}
            title="NO QUALIFIED LEADS DETECTED"
            description="No current-rule company-potential leads or commercial-reply leads are available in this dataset."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 space-y-2">
              <div className="relative mb-3">
                <Search className="w-4 h-4 text-amber-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter leads on this page..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full bg-[#070b16] border border-amber-500/20 rounded-xl pl-9 pr-3 py-2 text-xs text-amber-100 placeholder-amber-200/40 focus:outline-none focus:border-amber-400"
                />
              </div>

              {(search.trim()
                ? leads.filter(l =>
                    (l.company_name || '').toLowerCase().includes(search.toLowerCase()) ||
                    (l.contact_name || '').toLowerCase().includes(search.toLowerCase()) ||
                    (l.product_requirement || '').toLowerCase().includes(search.toLowerCase())
                  )
                : leads
              ).map(l => (
                <button
                  key={l.id}
                  onClick={() => { setSelected(l); setEmailPreview(null); }}
                  className={`w-full text-left bg-[#0e1424] border rounded-xl p-4 transition-colors ${
                    selected?.id === l.id ? 'border-amber-400 bg-amber-500/5' : 'border-amber-500/10 hover:border-amber-500/30'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span className="text-amber-50 font-medium truncate text-sm" title={l.company_name}>{l.company_name}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Pill label={l.intent_type} color="emerald" />
                      {l.qualification_class === 'HISTORICAL_LEGACY' && <Pill label="LEGACY" color="slate" />}
                      {l.qualification_class === 'CURRENT_RULE' && <Pill label="CURRENT RULE" color="sky" />}
                    </div>
                  </div>
                  <div className="text-xs text-amber-200/60 mb-1 truncate">{l.contact_name || 'No contact assigned'}</div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-amber-300">Score: {l.score}</span>
                    <span className="text-amber-200/50">{l.confidence == null ? 'Confidence not estimated' : `Confidence: ${(Number(l.confidence) * 100).toFixed(0)}%`}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="lg:col-span-2">
              {selected ? (
                <div className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-6 sticky top-4">
                  <div className="flex items-start justify-between mb-4 gap-4">
                    <div className="min-w-0">
                      <h3 className="text-amber-50 text-lg font-medium break-words">{selected.company_name}</h3>
                      <div className="text-amber-200/60 text-sm mt-1">{selected.contact_name || 'No contact assigned'}</div>
                    </div>
                    <Pill label={selected.status} color={selected.status === 'NEW' ? 'amber' : selected.status === 'QUALIFIED' ? 'emerald' : 'slate'} />
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="bg-[#070b16] p-3 rounded-lg">
                      <div className="text-[10px] text-amber-200/50 uppercase">Intent</div>
                      <div className="text-amber-100 text-sm">{selected.intent_type}</div>
                    </div>
                    <div className="bg-[#070b16] p-3 rounded-lg">
                      <div className="text-[10px] text-amber-200/50 uppercase">Score</div>
                      <div className="text-amber-100 text-sm">{selected.score}/100</div>
                    </div>
                    <div className="bg-[#070b16] p-3 rounded-lg">
                      <div className="text-[10px] text-amber-200/50 uppercase">Confidence</div>
                      <div className="text-amber-100 text-sm">{selected.confidence == null ? 'Not estimated' : `${(Number(selected.confidence) * 100).toFixed(0)}%`}</div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="text-amber-200/50 text-xs uppercase tracking-wider mb-1">Product Requirement</div>
                    <div className="text-amber-100 text-sm">{selected.product_requirement}</div>
                  </div>

                  {selected.evidence?.snippet && (
                    <div className="mb-4">
                      <div className="text-amber-200/50 text-xs uppercase tracking-wider mb-1">Evidence (Reply Snippet)</div>
                      <div className="text-amber-100/80 text-sm bg-[#070b16] p-3 rounded-lg border border-amber-500/10 italic">
                        "{selected.evidence.snippet}"
                      </div>
                    </div>
                  )}

                  {selected.evidence?.source === 'company_potential' && (
                    <div className="mb-4 bg-[#070b16] border border-amber-500/10 rounded-lg p-4">
                      <div className="text-amber-200/50 text-xs uppercase tracking-wider mb-2">Qualification Evidence</div>
                      <div className="text-amber-100 text-sm mb-3">
                        Existing company potential: {selected.evidence.potentialCategory} · {selected.evidence.score}/100 · potential record {selected.evidence.potentialId}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        {Object.entries(selected.evidence.factors || {}).map(([factor, value]) => (
                          <div key={factor} className="bg-[#0e1424] p-2 rounded">
                            <div className="text-amber-200/40">{factor.replace(/([A-Z])/g, ' $1')}</div>
                            <div className="text-amber-100">{value}</div>
                          </div>
                        ))}
                      </div>
                      <div className="text-amber-200/60 text-xs mt-3">
                        Recorded products: {(selected.evidence.companyEvidence?.products || []).join(', ') || 'None'} · Transactions: {selected.evidence.companyEvidence?.transactions ?? 'Not recorded'} · Trade value: {selected.evidence.companyEvidence?.tradeValue ?? 'Not recorded'}
                      </div>
                    </div>
                  )}

                  {selected.qualification_class === 'HISTORICAL_LEGACY' && (
                    <div className="mb-4 rounded-lg border border-slate-500/30 bg-slate-500/10 p-3 text-xs text-slate-200">
                      HISTORICAL / LEGACY LEAD — retained for recordkeeping and excluded from the current qualification and outreach flow.
                    </div>
                  )}

                  <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                    <div className="text-amber-200 text-xs uppercase tracking-wider mb-1">Recommended Human Action</div>
                    <div className="text-amber-100 text-sm">{selected.recommended_human_action}</div>
                  </div>

                  <div className="text-amber-200/40 text-xs mb-4">Detected {formatDate(selected.created_at)}</div>

                  <div className="flex gap-2 flex-wrap">
                    <button onClick={generatePitchPreview} disabled={draftGenerating || selected.qualification_class === 'HISTORICAL_LEGACY'} title={selected.qualification_class === 'HISTORICAL_LEGACY' ? 'Historical / legacy leads are excluded from current outreach.' : undefined} className="px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-50 text-amber-200 rounded text-xs flex items-center gap-1">
                      {draftGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                      {selected.qualification_class === 'HISTORICAL_LEGACY' ? 'Legacy lead — preview disabled' : 'Generate Pitch Preview'}
                    </button>
                    <button onClick={() => updateStatus(selected.id, 'QUALIFIED')} className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 rounded text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Mark Qualified
                    </button>
                    <button onClick={() => updateStatus(selected.id, 'HOLD')} className="px-3 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 text-sky-200 rounded text-xs">
                      Hold
                    </button>
                    <button onClick={() => updateStatus(selected.id, 'DISMISSED')} className="px-3 py-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 rounded text-xs flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> Dismiss
                    </button>
                  </div>

                  {displayedEmailPreview && (
                    <div className="mt-4 bg-[#070b16] border border-sky-500/20 rounded-lg p-4">
                      <div className="text-sky-200 text-xs font-medium mb-2">
                        {displayedEmailPreview.status === 'PREVIEW' ? 'DRAFT / PREVIEW · NON-SENDABLE' : 'SENDABLE DRAFT · HUMAN APPROVAL REQUIRED'}
                      </div>
                      {displayedEmailPreview.reason && <div className="text-amber-200/70 text-xs mb-2">{displayedEmailPreview.reason}</div>}
                      {displayedEmailPreview.preview ? (
                        <>
                          <div className="text-xs text-amber-100 mb-2"><strong>Subject:</strong> {displayedEmailPreview.preview.subject}</div>
                          <div className="text-[10px] text-amber-200/50 mb-2">{displayedEmailPreview.preview.recipientEmail || 'Verified contact required before sending.'}</div>
                          <pre className="whitespace-pre-wrap font-sans text-xs text-amber-100/80">{displayedEmailPreview.preview.bodyText}</pre>
                          <div className="text-[10px] text-amber-200/40 mt-2">Evidence: {displayedEmailPreview.preview.evidence.products.join(', ')}{displayedEmailPreview.preview.evidence.country ? ` · ${displayedEmailPreview.preview.evidence.country}` : ''} · score {displayedEmailPreview.preview.evidence.score}</div>
                        </>
                      ) : displayedEmailPreview.draft ? (
                        <>
                          <div className="text-xs text-amber-100 mb-2"><strong>Subject:</strong> {displayedEmailPreview.draft.subject}</div>
                          <pre className="whitespace-pre-wrap font-sans text-xs text-amber-100/80">{displayedEmailPreview.draft.body_text}</pre>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-12 text-center">
                  <Eye className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-amber-200/60 text-sm">Select a lead to view evidence and decide the next commercial action.</p>
                </div>
              )}
            </div>
          </div>
        )}
        {!loading && leads.length > 0 && (
          <div className="flex items-center justify-between mt-4 text-xs text-amber-200/60">
            <span>{pageInfo.total.toLocaleString()} persisted leads · page {pageInfo.page} of {Math.max(1, pageInfo.totalPages)}</span>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => fetchLeads(page - 1)} className="px-3 py-1.5 border border-amber-500/20 rounded disabled:opacity-40">Previous</button>
              <button disabled={page >= pageInfo.totalPages} onClick={() => fetchLeads(page + 1)} className="px-3 py-1.5 border border-amber-500/20 rounded disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
