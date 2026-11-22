import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Users, Plus, Search, ShieldOff, Mail, Phone, RotateCcw, Globe } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Pill, EmptyState, LoadingState, formatDate } from '../components/UI';
import { useOutletContext } from 'react-router-dom';
import { runUiAction } from '../lib/api-auth-errors';

export default function Contacts() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [form, setForm] = useState({ company_id: '', name: '', role: '', email: '', phone: '', source_url: '' });
  const [companies, setCompanies] = useState([]);
  const [leads, setLeads] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchContacts = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/contacts');
      const json = await res.json();
      setContacts(Array.isArray(json) ? json : json?.data || []);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const fetchCompanies = async () => {
    try {
      const res = await apiFetch('/api/companies?mode=picker');
      const json = await res.json();
      setCompanies(Array.isArray(json) ? json : json?.data || []);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const fetchQualifiedLeads = async () => {
    try {
      const res = await apiFetch('/api/leads');
      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : [];
      setLeads(list.filter(lead =>
        lead.qualification_class === 'CURRENT_RULE' ||
        lead.current_rule_qualified === true ||
        (Number(lead.score || 0) >= 75 && Number(lead.companies?.total_transactions || 0) >= 10)
      ));
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  useEffect(() => { fetchContacts(); fetchCompanies(); fetchQualifiedLeads(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);
    try {
      const res = await apiFetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'MANUAL_ADD',
          ...form,
          company_id: form.company_id ? Number(form.company_id) : null
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.message || 'Failed to save contact');
      setMessage({ type: 'success', text: 'Contact saved as UNVERIFIED. Review the saved public source before marking it verified.' });
      setShowAdd(false);
      setForm({ company_id: '', name: '', role: '', email: '', phone: '', source_url: '' });
      await fetchContacts();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const discoverContacts = async (e) => {
    e.preventDefault();
    if (!selectedLeadId) return;
    setDiscovering(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'DISCOVER', leadId: Number(selectedLeadId) })
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || result.reason || 'Contact discovery failed.');
      }
      const count = Number(result.contactsCreated || 0);
      setMessage({
        type: count > 0 ? 'success' : 'warning',
        text: count
          ? `${count} public email candidate${count === 1 ? '' : 's'} saved as UNVERIFIED. Review each source before verification.`
          : result.reason || result.error || 'No public business email candidates were found on official web sources.'
      });
      setShowDiscover(false);
      await fetchContacts();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setDiscovering(false);
    }
  };

  const suppressContact = async (id) => {
    try {
      await apiFetch('/api/contacts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, is_suppressed: true, suppression_reason: 'Manually marked as do-not-contact' })
      });
      setMessage({ type: 'success', text: 'This email address is now suppressed across the shared workspace.' });
      await fetchContacts();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const verifyContact = async (id) => {
    setMessage(null);
    await runUiAction(async () => {
      await apiFetch('/api/contacts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'VERIFY' })
      });
      setMessage({ type: 'success', text: 'Contact marked VERIFIED after human source review.' });
      await fetchContacts();
    }, message => setMessage({ type: 'error', text: message }));
  };

  const filtered = contacts.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name = String(c.name || '').toLowerCase();
    const email = String(c.email || '').toLowerCase();
    const comp = String(c.company_name || c.companies?.name || '').toLowerCase();
    const role = String(c.role || '').toLowerCase();
    return name.includes(q) || email.includes(q) || comp.includes(q) || role.includes(q);
  });

  return (
    <>
      <Topbar
        title="Public Contacts Directory"
        subtitle="Manually entered contacts remain UNVERIFIED until a person reviews the saved public source."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        actions={
          <div className="flex gap-2 items-center">
            <button
              onClick={() => { fetchContacts(); fetchCompanies(); fetchQualifiedLeads(); }}
              title="Refresh directory"
              className="p-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-200 rounded-lg text-xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowDiscover(!showDiscover)} className="px-3.5 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-200 text-xs font-semibold rounded-lg flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" /> Discover from Lead
            </button>
            <button onClick={() => setShowAdd(!showAdd)} className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-[#070b16] text-xs font-semibold rounded-lg flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add Contact
            </button>
          </div>
        }
      />
      <div className="p-4 lg:p-8">
        {message && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30' : message.type === 'warning' ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30' : 'bg-rose-500/10 text-rose-200 border border-rose-500/30'}`}>
            {message.text}
          </div>
        )}

        {showDiscover && (
          <form onSubmit={discoverContacts} className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-5 mb-6">
            <h3 className="text-amber-50 font-medium mb-2 flex items-center gap-2">
              <Globe className="w-4 h-4 text-amber-400" /> Discover Public Business Contacts
            </h3>
            <p className="text-xs text-amber-200/60 mb-4">
              Runs one targeted web search for a qualified lead using legitimate public business sources. Discovered candidates are saved as UNVERIFIED with source URLs and never sent emails automatically.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <select
                required
                value={selectedLeadId}
                onChange={(e) => setSelectedLeadId(e.target.value)}
                className="flex-1 bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none"
              >
                <option value="">Select a qualified lead (score ≥ 75 & ≥ 10 transactions)…</option>
                {leads.map(lead => {
                  const compName = lead.companies?.name || lead.company_name || `Company #${lead.company_id}`;
                  const shortName = compName.length > 60 ? compName.slice(0, 57) + '…' : compName;
                  return (
                    <option key={lead.id} value={lead.id}>
                      {shortName} · Score {Number(lead.score || 0).toFixed(0)} ({lead.companies?.total_transactions || 0} txs)
                    </option>
                  );
                })}
              </select>
              <button disabled={!selectedLeadId || discovering} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center justify-center gap-2">
                {discovering ? 'Searching…' : 'Search Public Sources'}
              </button>
            </div>
            {leads.length === 0 && (
              <p className="text-xs text-amber-400/80 mt-2">
                Note: Lead qualification criteria requires total_score ≥ 75 and total_transactions ≥ 10.
              </p>
            )}
          </form>
        )}

        {showAdd && (
          <form onSubmit={handleSubmit} className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-6 mb-6">
            <h3 className="text-amber-50 font-medium mb-4 flex items-center gap-2">
              <Plus className="w-4 h-4 text-amber-400" /> Add Contact for Source Review
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <select required value={form.company_id} onChange={(e) => setForm({...form, company_id: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none">
                <option value="">Select company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input required placeholder="Contact name" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
              <input placeholder="Role (e.g. Head of Procurement)" value={form.role} onChange={(e) => setForm({...form, role: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
              <input required type="email" placeholder="Public business email to review" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
              <input placeholder="Phone (optional)" value={form.phone} onChange={(e) => setForm({...form, phone: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
              <input required type="url" placeholder="Public source URL (HTTPS)" value={form.source_url} onChange={(e) => setForm({...form, source_url: e.target.value})} className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            </div>
            <div className="flex gap-2 mt-4">
              <button type="submit" className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-[#070b16] font-semibold rounded-lg text-sm">Save Contact</button>
              <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 bg-amber-500/10 text-amber-200 rounded-lg text-sm">Cancel</button>
            </div>
          </form>
        )}

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts by name, email, company, or role…" className="w-full bg-[#0e1424] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
        </div>

        {loading ? <LoadingState /> : contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="NO CONTACTS SAVED YET"
            description="Use 'Discover from Lead' to find public business contacts from official web sources for qualified leads, or manually add a contact with its public HTTPS source. All newly discovered contacts remain UNVERIFIED until reviewed."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="NO MATCHING CONTACTS"
            description={`No contacts match "${search}". Try searching for another name, email, or company.`}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filtered.map(c => {
              const displayName = c.name || (c.email ? c.email.split('@')[0] : 'Public Business Contact');
              const displayCompany = c.company_name || c.companies?.name || 'Company';
              const displayCountry = c.company_country || c.companies?.country;
              return (
                <div key={c.id} className={`bg-[#0e1424] border rounded-2xl p-5 ${c.is_suppressed ? 'border-rose-500/30 opacity-70' : 'border-amber-500/10'}`}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-amber-50 font-medium">{displayName}</h3>
                      <div className="text-amber-200/60 text-xs mt-1">{c.role || 'Procurement / Trade Contact'}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Pill label={c.verification_status || 'UNVERIFIED'} color={c.verification_status === 'VERIFIED' ? 'emerald' : 'amber'} />
                      {c.is_suppressed && <Pill label="SUPPRESSED" color="red" />}
                    </div>
                  </div>
                  <div className="text-xs text-amber-200/60 mb-2 font-medium">
                    {displayCompany}{displayCountry ? ` · ${displayCountry}` : ''}
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-2 text-amber-100"><Mail className="w-3 h-3 text-amber-400" /> {c.email}</div>
                    {c.phone && <div className="flex items-center gap-2 text-amber-100"><Phone className="w-3 h-3 text-amber-400" /> {c.phone}</div>}
                  </div>
                  <div className="text-[10px] text-amber-200/40 mt-3 pt-3 border-t border-amber-500/10">
                    Source: {c.source || 'MANUAL'} · {c.discovery_provider || 'manual'} · {c.confidence == null ? 'Confidence not estimated' : `Confidence: ${(Number(c.confidence) * 100).toFixed(0)}%`} · Discovered {formatDate(c.discovered_at || c.created_at)}
                  </div>
                  {c.source_url && (
                    <div className="mt-2">
                      <a href={c.source_url} target="_blank" rel="noreferrer" className="text-xs text-sky-300 underline underline-offset-2">
                        Review public source
                      </a>
                    </div>
                  )}
                  {c.verification_status !== 'VERIFIED' && (
                    <button onClick={() => verifyContact(c.id)} className="mt-3 w-full py-1.5 text-xs rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 border border-amber-500/30 transition-colors">
                      Mark verified after review
                    </button>
                  )}
                  {!c.is_suppressed && (
                    <button
                      onClick={() => suppressContact(c.id)}
                      className="mt-2 w-full py-1.5 text-xs rounded flex items-center justify-center gap-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-colors"
                    >
                      <ShieldOff className="w-3 h-3" /> Suppress email
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
