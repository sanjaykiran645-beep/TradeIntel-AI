import { useCallback, useEffect, useRef, useState } from 'react';
import apiFetch from '../lib/api';
import { Building2, Activity, Mail, MessageSquare, Target, AlertCircle, Search } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, ErrorBanner, formatDate } from '../components/UI';
import { useOutletContext } from 'react-router-dom';
import { asList, asPage, describeApiError, toResearchView } from '../lib/api-data';

const DETAIL_TIMEOUT_MS = 20000;
const EMPTY_DETAILS = { emails: [], contacts: [], activities: [], inbox: [], leads: [], followups: [], research: [] };
const DETAIL_SECTIONS = [
  { key: 'emails', label: 'Outreach', url: id => `/api/email-engine?companyId=${id}` },
  { key: 'contacts', label: 'Contacts', url: id => `/api/contacts?companyId=${id}` },
  { key: 'activities', label: 'CRM activity', url: id => `/api/crm?companyId=${id}` },
  { key: 'inbox', label: 'Replies', url: id => `/api/inbox?companyId=${id}` },
  { key: 'leads', label: 'Leads', url: id => `/api/leads?companyId=${id}` },
  { key: 'followups', label: 'Follow-ups', url: id => `/api/followup?companyId=${id}` },
  { key: 'research', label: 'Research', url: id => `/api/research?companyId=${id}` }
];

export default function Customer360() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const [companies, setCompanies] = useState([]);
  const [companySearch, setCompanySearch] = useState('');
  const [companyPage, setCompanyPage] = useState(1);
  const [companyPageInfo, setCompanyPageInfo] = useState({ total: 0, totalPages: 0 });
  const [selected, setSelected] = useState(null);
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [sectionErrors, setSectionErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState(null);
  const listRequest = useRef(0);

  const fetchCompanies = useCallback(async () => {
    const requestId = ++listRequest.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(companyPage),
        pageSize: '50',
        sort: 'value',
        ...(companySearch.trim() ? { search: companySearch.trim() } : {})
      });
      const response = await apiFetch(`/api/companies?${params}`);
      const page = asPage(await response.json());
      if (requestId !== listRequest.current) return; // a newer search/page superseded this response
      setCompanies(page.rows);
      setCompanyPageInfo({ total: page.total, totalPages: page.totalPages });
      setError(null);
    } catch (err) {
      if (requestId === listRequest.current) setError(describeApiError(err).text);
    } finally {
      if (requestId === listRequest.current) setLoading(false);
    }
  }, [companyPage, companySearch]);

  useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

  useEffect(() => {
    if (!selected) return undefined;
    // Each selection gets its own cancellation scope so a slow response for a previously
    // selected company can never overwrite the company the operator is looking at now.
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
    setDetailsLoading(true);
    setDetails(EMPTY_DETAILS);
    setSectionErrors({});

    Promise.allSettled(DETAIL_SECTIONS.map(async section => {
      const response = await apiFetch(section.url(selected.id), { signal: controller.signal });
      // Defensive: only keep rows that actually belong to this company.
      return asList(await response.json()).filter(row => row.company_id == null || String(row.company_id) === String(selected.id));
    })).then(results => {
      if (cancelled) return;
      const next = { ...EMPTY_DETAILS };
      const failures = {};
      results.forEach((result, index) => {
        const section = DETAIL_SECTIONS[index];
        if (result.status === 'fulfilled') next[section.key] = result.value;
        else failures[section.key] = controller.signal.aborted ? 'Timed out' : describeApiError(result.reason).text;
      });
      setDetails(next);
      setSectionErrors(failures);
    }).finally(() => {
      clearTimeout(timeout);
      if (!cancelled) setDetailsLoading(false);
    });

    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [selected]);

  const failedSections = Object.entries(sectionErrors);

  return (
    <>
      <Topbar
        title="Customer 360"
        subtitle="Complete unified view: trade data, intelligence, research, contacts, outreach, replies, follow-ups, leads and CRM history."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {loading && companies.length === 0 && !companySearch.trim() ? <LoadingState /> : !loading && companies.length === 0 && !companySearch.trim() ? (
          <EmptyState
            icon={Building2}
            title="NO CUSTOMER DATA AVAILABLE"
            description="Upload a trade dataset to populate the unified Customer 360 view."
          />
        ) : (
          <>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
            <input
              value={companySearch}
              onChange={event => { setCompanySearch(event.target.value); setCompanyPage(1); }}
              placeholder="Search companies…"
              className="w-full bg-[#0e1424] border border-amber-500/20 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
            />
          </div>
          <div className="mb-3 text-xs text-amber-200/60">{companyPageInfo.total.toLocaleString()} companies · page {companyPage} of {companyPageInfo.totalPages}</div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className={`lg:col-span-1 space-y-2 max-h-[80vh] overflow-y-auto transition-opacity ${loading ? 'opacity-60' : ''}`}>
              {companies.length === 0 && (
                <div className="rounded-xl border border-dashed border-amber-500/20 p-6 text-center text-sm text-amber-200/60">
                  {loading ? 'Searching…' : 'No companies match this search.'}
                </div>
              )}
              {companies.map(c => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={`w-full text-left bg-[#0e1424] border rounded-xl p-4 transition-colors ${
                    selected?.id === c.id ? 'border-amber-400 bg-amber-500/5' : 'border-amber-500/10 hover:border-amber-500/30'
                  }`}
                >
                  <div className="text-amber-50 font-medium">{c.name}</div>
                  <div className="text-amber-200/60 text-xs">{c.country || 'Global'}</div>
                  {c.potential && (
                    <div className="mt-2 flex items-center gap-2">
                      <Pill label={c.potential.category} color={c.potential.category === 'VERY_HIGH' ? 'emerald' : c.potential.category === 'HIGH' ? 'amber' : 'slate'} />
                      <span className="text-xs text-amber-300">{c.potential.total_score}/100</span>
                    </div>
                  )}
                </button>
              ))}
            </div>

            <div className="lg:col-span-2">
              {!selected ? (
                <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-12 text-center">
                  <Building2 className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-amber-200/60 text-sm">Select a company to see its complete Customer 360 view.</p>
                </div>
              ) : detailsLoading ? (
                <LoadingState label={`Loading ${selected.name}…`} />
              ) : (
                <>
                {failedSections.length > 0 && (
                  <ErrorBanner error={`Some sections could not be loaded: ${failedSections.map(([key, message]) => `${DETAIL_SECTIONS.find(section => section.key === key)?.label || key} (${message})`).join('; ')}`} />
                )}
                <div className="space-y-4">
                  <div className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-6">
                    <h3 className="text-amber-50 text-xl font-medium">{selected.name}</h3>
                    <div className="text-amber-200/60 text-sm mt-1">{selected.industry} · {selected.country}</div>
                    <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
                      <div><div className="text-amber-200/50 text-xs">Transactions</div><div className="text-amber-50 font-medium">{selected.total_transactions}</div></div>
                      <div><div className="text-amber-200/50 text-xs">Recorded amount · complete INR evidence</div><div className="text-amber-50 font-medium">{selected.total_value == null ? 'Unavailable' : Number(selected.total_value).toLocaleString()}</div></div>
                      <div><div className="text-amber-200/50 text-xs">Last Active</div><div className="text-amber-50 font-medium">{selected.last_activity_date || '—'}</div></div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-[#0e1424] border border-amber-500/10 rounded-xl p-4">
                      <Mail className="w-4 h-4 text-amber-400 mb-2" />
                      <div className="text-2xl font-light text-amber-50">{details.emails.length}</div>
                      <div className="text-[10px] text-amber-200/50 uppercase">Outreach</div>
                    </div>
                    <div className="bg-[#0e1424] border border-amber-500/10 rounded-xl p-4">
                      <Building2 className="w-4 h-4 text-amber-400 mb-2" />
                      <div className="text-2xl font-light text-amber-50">{details.contacts.length}</div>
                      <div className="text-[10px] text-amber-200/50 uppercase">Contacts</div>
                    </div>
                    <div className="bg-[#0e1424] border border-amber-500/10 rounded-xl p-4">
                      <MessageSquare className="w-4 h-4 text-amber-400 mb-2" />
                      <div className="text-2xl font-light text-amber-50">{details.inbox.length}</div>
                      <div className="text-[10px] text-amber-200/50 uppercase">Replies</div>
                    </div>
                    <div className="bg-[#0e1424] border border-amber-500/10 rounded-xl p-4">
                      <Target className="w-4 h-4 text-amber-400 mb-2" />
                      <div className="text-2xl font-light text-amber-50">{details.leads.length}</div>
                      <div className="text-[10px] text-amber-200/50 uppercase">Leads</div>
                    </div>
                  </div>

                  {Object.values(details).every(rows => rows.length === 0) && failedSections.length === 0 && (
                    <div className="rounded-xl border border-dashed border-amber-500/20 p-4 text-sm text-amber-200/60">
                      No research, contacts, outreach, replies, leads, follow-ups or CRM activity are recorded for this company yet.
                    </div>
                  )}

                  {details.research.length > 0 && (() => {
                    const view = toResearchView(details.research[0]);
                    return (
                      <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                        <h4 className="text-amber-50 font-medium mb-2 flex items-center gap-2">
                          Public Web Research <Pill label={view.status.replace('_', ' ')} color={view.status === 'COMPLETED' ? 'emerald' : view.status === 'NO_EVIDENCE' ? 'amber' : 'rose'} />
                        </h4>
                        {view.summary && <p className="text-sm text-amber-100/80">{view.summary} <span className="text-[10px] text-amber-200/40">(provider-generated summary, not independently verified)</span></p>}
                        {view.reason && <p className="text-sm text-amber-200/60">{view.reason}</p>}
                        {view.sources.length > 0 && (
                          <ul className="mt-2 space-y-1 text-xs">
                            {view.sources.slice(0, 5).map(source => (
                              <li key={source.url}><a className="text-amber-300 hover:underline break-all" href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })()}

                  <div className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-5">
                    <h4 className="text-amber-50 font-medium mb-3 flex items-center gap-2"><Activity className="w-4 h-4" /> Activity Timeline</h4>
                    {details.activities.length === 0 ? (
                      <p className="text-amber-200/50 text-sm">No activity recorded.</p>
                    ) : (
                      <div className="space-y-2">
                        {details.activities.map(a => (
                          <div key={a.id} className="border-l-2 border-amber-500/30 pl-3 py-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-amber-100">{a.title}</span>
                              <span className="text-amber-200/40">{formatDate(a.created_at)}</span>
                            </div>
                            <div className="text-[11px] text-amber-200/60">{a.description}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between text-sm text-amber-200/70">
                  <span>Company list</span>
                  <div className="flex gap-2">
                    <button disabled={companyPage <= 1 || loading} onClick={() => setCompanyPage(value => Math.max(1, value - 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40">Previous</button>
                    <button disabled={companyPage >= companyPageInfo.totalPages || loading} onClick={() => setCompanyPage(value => Math.min(companyPageInfo.totalPages, value + 1))} className="rounded-lg border border-amber-500/20 px-3 py-2 disabled:opacity-40">Next</button>
                  </div>
                </div>
                </>
              )}
            </div>
          </div>
          </>
        )}
      </div>
    </>
  );
}
