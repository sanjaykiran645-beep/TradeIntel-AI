import { useCallback, useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Building2, Search, Loader2, Sparkles, TrendingUp } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { useOutletContext } from 'react-router-dom';

export default function Companies() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scoringLoading, setScoringLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 0 });
  const [error, setError] = useState(null);

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '50',
        sort: 'value',
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(filter !== 'ALL' ? { category: filter } : {})
      });
      const res = await apiFetch(`/api/companies?${params}`);
      const result = await res.json();
      setCompanies(result.data || []);
      setPageInfo({ total: result.total, totalPages: result.totalPages });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, filter]);

  useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

  const runScoring = async () => {

    if (scoringLoading) return; // prevent duplicate submissions
    setError(null);
    setScoringLoading(true);
    try {
      const response = await apiFetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const result = await response.json();
      await fetchCompanies();
      if (result?.success !== true) {
        setError(`Potential scoring requires review: ${result?.reason || 'Some factors do not have source evidence.'}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setScoringLoading(false);
    }
  };


  return (
    <>
      <Topbar
        title="Companies"
        subtitle="Real entities extracted from imported trade datasets. No mock data."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <button onClick={runScoring} disabled={scoringLoading} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-2">
            {scoringLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Recalculate Potential
          </button>
        }
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="flex flex-col md:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search companies or markets…"
              className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
          </div>
          <div className="flex gap-1 bg-[#0e1424] border border-amber-500/20 rounded-lg p-1">
            {['ALL', 'VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW'].map(c => (
              <button
                key={c}
                onClick={() => { setFilter(c); setPage(1); }}
                className={`px-3 py-1.5 text-xs rounded ${
                  filter === c ? 'bg-amber-500 text-[#070b16] font-semibold' : 'text-amber-200/60 hover:text-amber-100'
                }`}
              >
                {c.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        {loading ? <LoadingState /> : companies.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={pageInfo.total === 0 ? 'NO BUSINESS DATA AVAILABLE' : 'No companies match your filter'}
            description={pageInfo.total === 0 ? 'Upload a trade dataset to populate the Companies intelligence layer.' : 'Try a different search or filter.'}
          />
        ) : (
          <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {companies.map(c => (
              <div key={c.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-amber-50 font-medium text-lg">{c.name}</h3>
                    <div className="text-amber-200/60 text-xs mt-1">{c.industry || 'Global Trading & Procurement'} · {c.country || 'Global'}</div>
                  </div>
                  {c.potential && (
                    <Pill
                      label={c.potential.category}
                      color={c.potential.category === 'VERY_HIGH' ? 'emerald' : c.potential.category === 'HIGH' ? 'amber' : c.potential.category === 'MEDIUM' ? 'sky' : 'slate'}
                    />
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3 my-4 text-sm">
                  <div>
                    <div className="text-amber-200/50 text-xs">Transactions</div>
                    <div className="text-amber-50 font-medium">{c.total_transactions || 0}</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Recorded Amount · complete INR evidence</div>
                    <div className="text-amber-50 font-medium">{c.total_value == null ? 'Unavailable' : Number(c.total_value).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Last Active</div>
                    <div className="text-amber-50 font-medium text-xs">{c.last_activity_date || '—'}</div>
                  </div>
                </div>

                {c.primary_products && c.primary_products.length > 0 && (
                  <div className="mb-3">
                    <div className="text-amber-200/50 text-xs uppercase tracking-wider mb-1">Procurement Profile</div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.primary_products.slice(0, 4).map((p, i) => (
                        <span key={i} className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-200 px-2 py-1 rounded">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {c.potential && (
                  <div className="border-t border-amber-500/10 pt-3 mt-3">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-xs text-amber-200/60">Customer Potential Score</span>
                      <span className="ml-auto text-amber-50 font-semibold">{c.potential.total_score}/100</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1 text-[10px]">
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Product</div><div className="text-amber-100">{c.potential.product_fit_score}/20</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Activity</div><div className="text-amber-100">{c.potential.activity_score}/15</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Recency</div><div className="text-amber-100">{c.potential.recency_score}/15</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Market</div><div className="text-amber-100">{c.potential.market_fit_score}/10</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Commercial</div><div className="text-amber-100">{c.potential.commercial_relevance_score}/15</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Growth</div><div className="text-amber-100">{c.potential.growth_score}/10</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Diversity</div><div className="text-amber-100">{c.potential.supplier_diversification_score}/5</div></div>
                      <div className="bg-[#070b16] rounded p-1.5"><div className="text-amber-200/40">Intent</div><div className="text-amber-100">{c.potential.engagement_score}/10</div></div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between text-sm text-amber-200/70">
            <span>{pageInfo.total.toLocaleString()} companies · page {page} of {pageInfo.totalPages}</span>
            <div className="flex gap-2">
              <button disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40">Previous</button>
              <button disabled={page >= pageInfo.totalPages || loading} onClick={() => setPage(value => Math.min(pageInfo.totalPages, value + 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40">Next</button>
            </div>
          </div>
          </>
        )}
      </div>
    </>
  );
}
