import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Search, Globe, Loader2, CheckCircle, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, formatDate } from '../components/UI';
import { useOutletContext } from 'react-router-dom';
import { toResearchView, describeApiError } from '../lib/api-data';

export default function Research() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const [companies, setCompanies] = useState([]);
  const [research, setResearch] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [researchingId, setResearchingId] = useState(null);
  const [researchingAll, setResearchingAll] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [cRes, rRes] = await Promise.all([apiFetch('/api/companies?mode=picker'), apiFetch('/api/research')]);
      const [cJson, rJson] = await Promise.all([cRes.json(), rRes.json()]);
      setCompanies(Array.isArray(cJson) ? cJson : cJson?.data || []);
      setResearch(Array.isArray(rJson) ? rJson : rJson?.data || []);
    } catch (err) {
      setMessage({ type: 'error', text: describeApiError(err).text });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const triggerResearch = async (companyId) => {
    setResearchingId(companyId);
    setMessage(null);
    try {
      const res = await apiFetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId })
      });
      const json = await res.json();
      setMessage({ type: 'success', text: `Public web intelligence gathered for ${json.company_name || 'selected company'}.` });
      await fetchData();
    } catch (err) {
      setMessage({ type: 'error', text: describeApiError(err).text });
    } finally {
      setResearchingId(null);
    }
  };

  const runAllResearch = async () => {
    setResearchingAll(true);
    setMessage(null);
    let successCount = 0;
    try {
      const pending = companies.filter(c => !research.some(r => r.company_id === c.id));
      if (pending.length === 0) {
        setMessage({ type: 'success', text: 'All available companies already have research records.' });
        return;
      }
      for (const c of pending) {
        try {
          await apiFetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId: c.id })
          });
          successCount++;
          // Small pause between research requests to respect provider rate limits
          await new Promise(r => setTimeout(r, 600));
        } catch (itemErr) {
          console.warn(`Research for ${c.name} failed:`, itemErr);
        }
      }
      setMessage({ type: 'success', text: `Completed public web intelligence for ${successCount} of ${pending.length} companies.` });
      await fetchData();
    } catch (err) {
      setMessage({ type: 'error', text: describeApiError(err).text });
    } finally {
      setResearchingAll(false);
    }
  };

  const filtered = companies.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  const researchMap = new Map(research.map(r => [r.company_id, r]));

  return (
    <>
      <Topbar
        title="Public Web Research"
        subtitle="Verifies official websites, public contact channels, business profile and operational footprint."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <button
            onClick={runAllResearch}
            disabled={researchingAll || Boolean(researchingId)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-2"
          >
            {researchingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
            Research Unresearched (Top 10)
          </button>
        }
      />
      <div className="p-4 lg:p-8">
        {message && (
          <div className={`mb-4 p-4 rounded-xl flex items-center gap-3 ${
            message.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200' : 'bg-rose-500/10 border border-rose-500/30 text-rose-200'
          }`}>
            {message.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0" /> : <AlertCircle className="w-5 h-5 flex-shrink-0" />}
            <span className="text-sm">{message.text}</span>
          </div>
        )}

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies to research…"
            className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
          />
        </div>

        {loading ? <LoadingState /> : filtered.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="NO BUSINESS DATA AVAILABLE"
            description="Upload a trade dataset first. Companies from the trade registry will appear here for public intelligence research."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filtered.map(c => {
              const r = researchMap.get(c.id);
              const rView = toResearchView(r);
              const isTargetBusy = researchingId === c.id;

              return (
                <div key={c.id} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="text-amber-50 font-medium">{c.name}</h3>
                        <div className="text-amber-200/60 text-xs mt-1">{c.country || 'Global'} · {c.industry || 'Trade'}</div>
                      </div>
                      {rView.present ? (
                        <Pill
                          label={rView.status.replace('_', ' ')}
                          color={
                            rView.status === 'COMPLETED' ? 'emerald' :
                            rView.status === 'NO_EVIDENCE' ? 'amber' :
                            rView.status === 'FAILED' ? 'rose' : 'slate'
                          }
                        />
                      ) : (
                        <Pill label="NOT RESEARCHED" color="slate" />
                      )}
                    </div>

                    {rView.present ? (
                      <div className="space-y-3 text-xs">
                        {rView.summary && (
                          <div className="text-amber-200/80 leading-relaxed bg-[#0a0f1c] p-3 rounded-xl border border-amber-500/10">
                            <span className="text-[10px] text-amber-400/70 font-semibold uppercase block mb-1">Provider Summary (Tavily AI)</span>
                            {rView.summary}
                          </div>
                        )}

                        {rView.reason && (
                          <div className="text-amber-300/80 bg-amber-500/10 p-2.5 rounded-lg border border-amber-500/20">
                            {rView.reason}
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-amber-500/10">
                          {rView.officialWebsite && (
                            <div>
                              <div className="text-amber-200/50 text-[10px] uppercase">Primary Website</div>
                              <a href={rView.officialWebsite} target="_blank" rel="noreferrer" className="text-amber-300 hover:underline flex items-center gap-1 truncate">
                                {rView.officialWebsite} <ExternalLink className="w-3 h-3 flex-shrink-0" />
                              </a>
                            </div>
                          )}
                          {rView.publicEmail && (
                            <div>
                              <div className="text-amber-200/50 text-[10px] uppercase">Public Email</div>
                              <div className="text-amber-100 font-mono truncate">{rView.publicEmail}</div>
                            </div>
                          )}
                          {rView.headquarters && (
                            <div>
                              <div className="text-amber-200/50 text-[10px] uppercase">HQ</div>
                              <div className="text-amber-100 truncate">{rView.headquarters}</div>
                            </div>
                          )}
                          {rView.publicPhone && (
                            <div>
                              <div className="text-amber-200/50 text-[10px] uppercase">Phone</div>
                              <div className="text-amber-100 font-mono truncate">{rView.publicPhone}</div>
                            </div>
                          )}
                        </div>

                        {rView.sources.length > 0 && (
                          <div className="pt-2 border-t border-amber-500/10">
                            <div className="text-amber-200/50 text-[10px] uppercase mb-1">Source Attribution ({rView.sources.length} sources)</div>
                            <div className="space-y-1">
                              {rView.sources.slice(0, 3).map((source, sIdx) => (
                                <a
                                  key={sIdx}
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-amber-300/90 hover:underline flex items-center gap-1 text-[11px] truncate"
                                >
                                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                                  <span className="truncate">{source.title || source.url}</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="text-amber-200/40 text-[10px] pt-2 border-t border-amber-500/5 flex justify-between">
                          <span>{rView.confidence != null ? `Confidence: ${(rView.confidence * 100).toFixed(0)}%` : 'Attributed'}</span>
                          <span>{rView.researchedAt ? `Verified ${formatDate(rView.researchedAt)}` : ''}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="my-2">
                        <p className="text-amber-200/50 text-xs">Public business intelligence not yet gathered for this company.</p>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-amber-500/10 flex justify-end">
                    <button
                      onClick={() => triggerResearch(c.id)}
                      disabled={isTargetBusy || researchingAll}
                      className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-lg hover:bg-amber-500/20 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isTargetBusy ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Searching…</span>
                        </>
                      ) : rView.present ? (
                        <>
                          <RefreshCw className="w-3 h-3" />
                          <span>Refresh Research</span>
                        </>
                      ) : (
                        <>
                          <Globe className="w-3 h-3" />
                          <span>Run Web Research</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
