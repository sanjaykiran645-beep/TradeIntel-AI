import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Package, Search } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner } from '../components/UI';
import { useOutletContext } from 'react-router-dom';

export default function Products() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 0 });
  const [error, setError] = useState(null);

  useEffect(() => {
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '50', ...(search.trim() ? { search: search.trim() } : {}) });
        const response = await apiFetch(`/api/products?${params}`);
        const result = await response.json();
        setProducts(result.data || []);
        setPageInfo({ total: result.total, totalPages: result.totalPages });
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [page, search]);

  return (
    <>
      <Topbar
        title="Product Intelligence"
        subtitle="Real demand patterns, frequency, buyers, suppliers, markets and recency derived from imported datasets."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search products or categories…"
            className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
          />
        </div>

        {loading ? <LoadingState /> : products.length === 0 ? (
          <EmptyState
            icon={Package}
            title="NO PRODUCT DATA AVAILABLE"
            description="Upload a trade dataset to populate the Product Intelligence layer."
          />
        ) : (
          <>
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {products.map(p => (
              <div key={p.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-amber-50 font-medium leading-tight pr-2">{p.name}</h3>
                  <Pill label={p.growth_trend || 'growing'} color="emerald" />
                </div>
                <div className="text-amber-200/50 text-xs mb-4">{p.category || 'General Procurement'}</div>

                <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
                  <div>
                    <div className="text-amber-200/50 text-xs">Total Demand</div>
                    <div className="text-amber-50 font-medium">{p.total_demand_qty == null ? 'Unavailable' : Number(p.total_demand_qty).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Recorded Amount · complete INR evidence</div>
                      <div className="text-amber-50 font-medium">{p.total_demand_val == null ? 'Unavailable' : Number(p.total_demand_val).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Frequency</div>
                    <div className="text-amber-50 font-medium">{p.frequency || 0} tx</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Last Demand</div>
                    <div className="text-amber-50 font-medium text-xs">{p.recency_date || '—'}</div>
                  </div>
                </div>

                {p.top_markets && p.top_markets.length > 0 && (
                  <div className="mb-2">
                    <div className="text-amber-200/50 text-[10px] uppercase tracking-wider mb-1">Top Markets</div>
                    <div className="flex flex-wrap gap-1">
                      {p.top_markets.slice(0, 4).map((m, i) => (
                        <span key={i} className="text-[10px] bg-sky-500/10 border border-sky-500/20 text-sky-200 px-1.5 py-0.5 rounded">
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {p.top_buyers && p.top_buyers.length > 0 && (
                  <div>
                    <div className="text-amber-200/50 text-[10px] uppercase tracking-wider mb-1">Top Buyers</div>
                    <div className="text-xs text-amber-100/80 leading-relaxed">
                      {p.top_buyers.slice(0, 3).join(', ')}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between text-sm text-amber-200/70">
            <span>{pageInfo.total.toLocaleString()} products · page {page} of {pageInfo.totalPages}</span>
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
