import { useCallback, useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Briefcase, Sparkles, Search, Loader2, CheckCircle2, ShieldAlert, Filter, ArrowRight } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, formatDate } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext, Link } from 'react-router-dom';
import { describeApiError } from '../lib/api-data';

export default function Opportunities() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(null);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('ALL'); // 'ALL' | 'QUALIFIED' | 'SCORED_ONLY'
  const [categoryFilter, setCategoryFilter] = useState('ALL'); // 'ALL' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW'
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 0 });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '50',
        sort: 'score',
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(filter !== 'ALL' ? { qualification: filter } : {}),
        ...(categoryFilter !== 'ALL' ? { category: categoryFilter } : {})
      });
      const res = await apiFetch(`/api/companies?${params}`);
      const result = await res.json();
      setCompanies(result.data || []);
      setPageInfo({ total: result.total || 0, totalPages: result.totalPages || 0 });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [page, search, filter, categoryFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const generateForCompany = async (companyId, leadId) => {
    setGenerating(companyId);
    setMessage(null);
    try {
      const res = await apiFetch('/api/email-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadId ? { leadId } : { companyId })
      });
      const json = await res.json();
      setMessage({ type: 'success', text: `Outreach draft prepared for ${json.company_name || 'selected company'}. Human approval is required before sending.` });
    } catch (err) {
      const described = describeApiError(err);
      if (described.kind === 'SAFEGUARD') {
        setMessage({
          type: 'warning',
          text: `Safeguard active: ${described.text}`,
          preview: described.preview
        });
      } else {
        setMessage({ type: 'error', text: described.text });
      }
    } finally {
      setGenerating(null);
    }
  };

  return (
    <>
      <Topbar
        title="Opportunities"
        subtitle="Companies scored by the 8-factor Customer Potential algorithm. Qualified leads (score ≥ 75 & ≥ 10 transactions) are prioritized for outreach."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        {message && (
          <div className={`mb-4 p-4 rounded-xl text-sm ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30'
              : message.type === 'warning'
                ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30'
                : 'bg-rose-500/10 text-rose-200 border border-rose-500/30'
          }`}>
            <div className="font-medium">{message.text}</div>
            {message.preview && (
              <div className="mt-2 p-3 bg-[#070b16] rounded-lg border border-amber-500/10 text-xs text-amber-100/80 font-mono whitespace-pre-wrap">
                {typeof message.preview === 'string' ? message.preview : JSON.stringify(message.preview, null, 2)}
              </div>
            )}
          </div>
        )}

        {/* Filter & Search Bar */}
        <div className="space-y-3 mb-6">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search opportunities by company or country…"
                className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
              className="bg-[#0e1424] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            >
              <option value="ALL">All Categories</option>
              <option value="VERY_HIGH">VERY HIGH (Score ≥ 80)</option>
              <option value="HIGH">HIGH (Score 65–79)</option>
              <option value="MEDIUM">MEDIUM (Score 40–64)</option>
              <option value="LOW">LOW (Score &lt; 40)</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5 bg-[#0e1424] border border-amber-500/15 rounded-lg p-1">
              {[
                { id: 'ALL', label: 'All Scored Records' },
                { id: 'QUALIFIED', label: 'Qualified Leads Only (≥ 75 & ≥ 10 txs)' },
                { id: 'SCORED_ONLY', label: 'Scored Only' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setFilter(tab.id); setPage(1); }}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                    filter === tab.id
                      ? 'bg-amber-500 text-[#070b16] font-semibold shadow'
                      : 'text-amber-200/60 hover:text-amber-100 hover:bg-amber-500/10'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="text-xs text-amber-200/60">
              {pageInfo.total.toLocaleString()} opportunities · ranked by Customer Potential score
            </div>
          </div>
        </div>

        {loading ? <LoadingState /> : companies.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="NO OPPORTUNITIES MATCH FILTER"
            description="No opportunities found matching your criteria. Try resetting the category or qualification filters to view all scored companies."
          />
        ) : (
          <div className="space-y-3">
            {companies.map(c => {
              const isQualified = Boolean(c.is_qualified);
              const score = c.potential?.total_score != null ? Number(c.potential.total_score).toFixed(1) : '—';
              const category = c.potential?.category || 'SCORED';

              return (
                <div key={c.id} className="bg-[#0e1424] border border-amber-500/10 hover:border-amber-500/20 transition-colors rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-amber-50 font-medium text-base">{c.name}</h3>
                      {c.potential && (
                        <Pill
                          label={category}
                          color={category === 'VERY_HIGH' ? 'emerald' : category === 'HIGH' ? 'amber' : category === 'MEDIUM' ? 'sky' : 'slate'}
                        />
                      )}
                      {isQualified ? (
                        <Pill label="QUALIFIED LEAD" color="emerald" />
                      ) : (
                        <Pill label="SCORED ONLY" color="slate" />
                      )}
                      {c.lead_status && (
                        <Pill label={`Lead: ${c.lead_status}`} color="sky" />
                      )}
                    </div>

                    <div className="text-amber-200/60 text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span><strong>Market:</strong> {c.country || 'Global'}</span>
                      <span>·</span>
                      <span><strong>Transactions:</strong> {c.total_transactions || 0}</span>
                      <span>·</span>
                      <span><strong>Recorded Value:</strong> {c.total_value == null ? 'unavailable' : `${Number(c.total_value).toLocaleString()} INR`}</span>
                      <span>·</span>
                      <span><strong>Last Activity:</strong> {c.last_activity_date ? formatDate(c.last_activity_date) : '—'}</span>
                    </div>

                    {Array.isArray(c.primary_products) && c.primary_products.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {c.primary_products.slice(0, 3).map((p, idx) => (
                          <span key={idx} className="px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-200/80 border border-amber-500/20 max-w-xs truncate">
                            {p}
                          </span>
                        ))}
                        {c.primary_products.length > 3 && (
                          <span className="text-[10px] text-amber-200/40 self-center">
                            +{c.primary_products.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-4 self-end sm:self-center">
                    <div className="text-right">
                      <div className="text-amber-50 text-2xl font-light">{score}</div>
                      <div className="text-[10px] text-amber-200/50 uppercase tracking-wider">Potential Score</div>
                    </div>

                    {isQualified ? (
                      <button
                        onClick={() => generateForCompany(c.id, c.lead_id)}
                        disabled={generating === c.id}
                        className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 rounded-lg text-xs font-semibold flex items-center gap-2 border border-amber-500/30 transition-colors whitespace-nowrap"
                        title="Prepare personalized draft using verified trade evidence"
                      >
                        {generating === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-amber-400" />}
                        Generate Outreach
                      </button>
                    ) : (
                      <span
                        className="px-3 py-1.5 rounded-lg text-[11px] bg-slate-800/40 text-amber-200/40 border border-amber-500/10 cursor-not-allowed whitespace-nowrap"
                        title={`Requires score ≥ 75 and ≥ 10 transactions (Current: score ${score}, ${c.total_transactions || 0} txs)`}
                      >
                        Qualification Pending
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && companies.length > 0 && (
          <div className="mt-6 flex items-center justify-between text-sm text-amber-200/70">
            <span>Page {page} of {Math.max(1, pageInfo.totalPages)}</span>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40 hover:bg-amber-500/10 text-xs">Previous</button>
              <button disabled={page >= pageInfo.totalPages} onClick={() => setPage(value => Math.min(pageInfo.totalPages, value + 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40 hover:bg-amber-500/10 text-xs">Next</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
