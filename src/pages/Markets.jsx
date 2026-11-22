import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Globe2, Search } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner } from '../components/UI';
import { useOutletContext } from 'react-router-dom';

export default function Markets() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch('/api/markets')
      .then(r => r.json())
      .then(d => setMarkets(Array.isArray(d) ? d : d?.data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = markets.filter(m => !search || m.country?.toLowerCase().includes(search.toLowerCase()) || m.region?.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <Topbar
        title="Market Intelligence"
        subtitle="Countries and regions where your trade partners operate. Identified gaps highlight Voyage IB supply opportunity."
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
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by country or region…"
            className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
          />
        </div>

        {loading ? <LoadingState /> : filtered.length === 0 ? (
          <EmptyState
            icon={Globe2}
            title="NO MARKET DATA AVAILABLE"
            description="Upload a trade dataset to populate the Market Intelligence layer."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(m => (
              <div key={m.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-amber-50 font-medium text-lg">{m.country}</h3>
                    <div className="text-amber-200/60 text-xs mt-1">{m.region || 'International'}</div>
                  </div>
                  <Globe2 className="w-5 h-5 text-amber-400" />
                </div>
                <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
                  <div>
                    <div className="text-amber-200/50 text-xs">Active Companies</div>
                    <div className="text-amber-50 font-medium">{m.active_companies_count || 0}</div>
                  </div>
                  <div>
                    <div className="text-amber-200/50 text-xs">Recorded Amount · complete INR evidence</div>
                    <div className="text-amber-50 font-medium">{m.total_trade_volume == null ? 'Unavailable' : Number(m.total_trade_volume).toLocaleString()}</div>
                  </div>
                </div>

                {m.top_demanded_products && m.top_demanded_products.length > 0 && (
                  <div className="mb-3">
                    <div className="text-amber-200/50 text-[10px] uppercase tracking-wider mb-1">Top Demanded Products</div>
                    <div className="flex flex-wrap gap-1">
                      {m.top_demanded_products.slice(0, 4).map((p, i) => (
                        <span key={i} className="text-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-200 px-1.5 py-0.5 rounded">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {m.market_gaps && m.market_gaps.length > 0 && (
                  <div>
                    <div className="text-amber-200/50 text-[10px] uppercase tracking-wider mb-1">Identified Gaps (Voyage IB Opportunity)</div>
                    <div className="space-y-1">
                      {m.market_gaps.map((g, i) => (
                        <div key={i} className="text-xs text-amber-100/80 flex items-start gap-1.5">
                          <span className="text-amber-400">›</span> {g}
                        </div>
                      ))}
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
