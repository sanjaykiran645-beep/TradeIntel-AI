import { useEffect, useState } from 'react';
import apiFetch from '../lib/api';
import { Settings, Save, AlertCircle, CheckCircle, RefreshCw, Trash2 } from 'lucide-react';
import Topbar from '../components/Topbar';
import { useAuth } from '../contexts/AuthContext';
import { Navigate, useOutletContext } from 'react-router-dom';

export default function Admin() {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useOutletContext() || {};
  const { user, role } = useAuth();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const [smtpHost, setSmtpHost] = useState('smtp.hostinger.com');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [imapHost, setImapHost] = useState('imap.hostinger.com');
  const [imapPort, setImapPort] = useState('993');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [fromName, setFromName] = useState('Voyage International Business');
  const [fromEmail, setFromEmail] = useState('');

  const [dailyMax, setDailyMax] = useState('100');
  const [hourlyMax, setHourlyMax] = useState('20');
  const [approvalMode, setApprovalMode] = useState('SUPERVISED');
  const [oauthBusy, setOauthBusy] = useState(false);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin');
      const json = await res.json();
      setConfig(json);
      if (json.limits) {
        setDailyMax(json.limits.dailyMax || '100');
        setHourlyMax(json.limits.hourlyMax || '20');
        setApprovalMode(json.limits.approvalMode || 'SUPERVISED');
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (role !== 'admin') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');
    const oauthErrorDescription = params.get('error_description');

    if (state && (code || oauthError)) {
      // Immediately strip OAuth parameters from the browser address bar
      window.history.replaceState({}, '', window.location.pathname);
      (async () => {
        setOauthBusy(true);
        try {
          const res = await apiFetch('/api/admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'COMPLETE_GMAIL_OAUTH',
              payload: {
                code,
                state,
                error: oauthError,
                errorDescription: oauthErrorDescription,
                fromName
              }
            })
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Gmail OAuth callback verification failed.');
          setMessage({ type: 'success', text: json.message || 'Gmail OAuth 2.0 connected and encrypted on the server.' });
        } catch (err) {
          setMessage({ type: 'error', text: err.message });
        } finally {
          setOauthBusy(false);
          await fetchConfig();
        }
      })();
    } else {
      fetchConfig();
    }
  }, [role]);

  const startGmailOAuth = async () => {
    setOauthBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'START_GMAIL_OAUTH',
          payload: {}
        })
      });
      const json = await res.json();
      if (!res.ok || !json.authorizationUrl) throw new Error(json.error || 'Could not start Gmail OAuth.');
      window.location.assign(json.authorizationUrl);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
      setOauthBusy(false);
    }
  };

  const checkGmailOAuth = async () => {
    setOauthBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CHECK_GMAIL_OAUTH' })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Gmail OAuth check failed.');
      setMessage({
        type: json.ok ? 'success' : 'error',
        text: json.ok
          ? `Gmail OAuth token verified for ${json.gmailOAuth?.email || 'configured mailbox'}.`
          : json.gmailOAuth?.reason || 'Gmail OAuth is not yet authorized.'
      });
      await fetchConfig();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setOauthBusy(false);
    }
  };

  const disconnectGmailOAuth = async () => {
    setOauthBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'DISCONNECT_GMAIL_OAUTH' })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not disconnect Gmail OAuth.');
      setMessage({ type: 'success', text: json.message || 'Gmail OAuth disconnected.' });
      await fetchConfig();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setOauthBusy(false);
    }
  };

  const saveHostinger = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'SAVE_HOSTINGER',
          payload: {
            smtpHost, smtpPort, smtpUser, smtpPass,
            imapHost, imapPort, imapUser, imapPass,
            fromName, fromEmail
          },
          userEmail: user?.email
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setMessage({ type: 'success', text: 'Hostinger SMTP/IMAP credentials encrypted and stored securely on the server.' });
      await fetchConfig();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const saveLimits = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'SAVE_LIMITS',
          payload: { dailyMax: Number(dailyMax), hourlyMax: Number(hourlyMax), approvalMode },
          userEmail: user?.email
        })
      });
      setMessage({ type: 'success', text: 'Sending limits and approval mode updated.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const purgeData = async () => {
    if (!confirm('Purge ALL business data (datasets, companies, contacts, outreach, inbox, leads)? This cannot be undone.')) return;
    try {
      await apiFetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'PURGE_TEST_DATA', userEmail: user?.email })
      });
      setMessage({ type: 'success', text: 'All data purged successfully.' });
      await fetchConfig();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  if (role !== 'admin') return <Navigate to="/dashboard" replace />;

  if (loading) {
    return (
      <>
        <Topbar title="Admin Settings" mobileSidebarOpen={mobileSidebarOpen} setMobileSidebarOpen={setMobileSidebarOpen} />
        <div className="p-8 text-amber-200/70">Loading admin configuration…</div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Admin Settings"
        subtitle="System administration: Hostinger SMTP/IMAP, sending limits, approval modes, RBAC and data management."
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
      />
      <div className="p-4 lg:p-8 space-y-6">
        {message && (
          <div className={`p-4 rounded-xl flex items-start gap-3 text-sm ${
            message.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200' : 'bg-rose-500/10 border border-rose-500/30 text-rose-200'
          }`}>
            {message.type === 'success' ? <CheckCircle className="w-5 h-5 mt-0.5" /> : <AlertCircle className="w-5 h-5 mt-0.5" />}
            <div>{message.text}</div>
          </div>
        )}

        <div className="p-4 rounded-xl border bg-amber-500/10 border-amber-500/30 text-amber-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-xs uppercase tracking-wider text-amber-300 font-semibold block">Active Email Workflow Mode</span>
              <strong className="text-base text-amber-50">{config?.emailMode || 'MANUAL GMAIL MODE'}</strong>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500 text-[#070b16]">
              {config?.emailMode || 'MANUAL GMAIL MODE'}
            </span>
          </div>
          <p className="mt-2 text-xs text-amber-200/80">
            No-cost manual Gmail workflow is active: approved outreach opens in your Gmail compose window for manual review and sending, and incoming replies can be pasted in the Inbox Manual Reply Import panel. Automatic email sending remains disabled (<code className="text-amber-100">EMAIL_SENDING_ENABLED=false</code>), and Gmail OAuth / Hostinger remain disconnected unless explicitly enabled later.
          </p>
        </div>

        <div className={`p-4 rounded-xl border ${
          config?.hostingerStatus === 'CONFIGURED' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
        }`}>
          <strong>Current Provider Status:</strong> {config?.hostingerStatus}
          {config?.hostingerDetails && (
            <span className="ml-2 text-xs opacity-80">
              ({config.hostingerDetails.host}:{config.hostingerDetails.port} · user: {config.hostingerDetails.user})
            </span>
          )}
        </div>
        <section className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <h3 className="text-amber-50 font-medium mb-4">Runtime & Provider Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {[
              ['PostgreSQL', config?.providers?.database],
              ['Authentication', config?.providers?.authentication],
              ['Original-file storage', config?.providers?.sourceFileStorage],
              ['Web research', config?.providers?.research],
              ['Contact discovery', config?.providers?.contactDiscovery],
              ['SMTP', config?.providers?.smtp],
              ['IMAP', config?.providers?.imap]
            ].map(([label, provider]) => (
              <div key={label} className="rounded-xl border border-amber-500/10 bg-[#070b16] p-3">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="text-amber-100">{label}</span>
                  <span className={provider?.configured ? 'text-emerald-300' : 'text-amber-300'}>
                    {provider?.configured ? 'CONFIGURED' : 'NOT CONFIGURED'}
                  </span>
                </div>
                {provider?.reason && <div className="mt-1 text-xs text-amber-200/60">{provider.reason}</div>}
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-amber-200/60">
            Database, authentication, and optional object-storage credentials are server environment settings and are never displayed here. Research and contact discovery require implemented providers; no results are fabricated when they are unavailable.
          </p>
        </section>
        {config?.credentialStorage === 'LEGACY_UNENCRYPTED' && (
          <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-200 text-sm">
            Existing Hostinger credentials are stored without encryption. New credentials require the server-side HOSTINGER_CONFIG_ENCRYPTION_KEY before they can be saved encrypted.
          </div>
        )}

        <section className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-amber-50 font-medium flex items-center gap-2">
              <Settings className="w-4 h-4" /> Gmail OAuth 2.0 Integration (Gmail API)
            </h3>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
              config?.gmailOAuth?.connected
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
            }`}>
              {config?.gmailOAuth?.status || 'NOT_CONFIGURED'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mb-4">
            <div className="rounded-xl border border-amber-500/10 bg-[#070b16] p-3">
              <div className="text-xs text-amber-200/60">Authorized Mailbox</div>
              <div className="text-amber-100 mt-1">{config?.gmailOAuth?.email || 'Not connected'}</div>
            </div>
            <div className="rounded-xl border border-amber-500/10 bg-[#070b16] p-3">
              <div className="text-xs text-amber-200/60">Granted Scopes</div>
              <div className="text-amber-100 mt-1 text-xs break-all">
                {config?.gmailOAuth?.scopes?.length ? config.gmailOAuth.scopes.join(', ') : 'None'}
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/10 bg-[#070b16] p-3">
              <div className="text-xs text-amber-200/60">Outbound Sending Flag</div>
              <div className={config?.gmailOAuth?.emailSendingEnabled ? 'text-emerald-300 mt-1' : 'text-amber-300 mt-1'}>
                {config?.gmailOAuth?.emailSendingEnabled ? 'ENABLED (EMAIL_SENDING_ENABLED=true)' : 'DISABLED (EMAIL_SENDING_ENABLED=false)'}
              </div>
            </div>
          </div>
          {config?.gmailOAuth?.reason && (
            <div className="text-xs text-amber-200/70 mb-4">{config.gmailOAuth.reason}</div>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startGmailOAuth}
              disabled={oauthBusy || !config?.gmailOAuth?.clientConfigured}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" /> Authorize Gmail Account
            </button>
            <button
              type="button"
              onClick={checkGmailOAuth}
              disabled={oauthBusy || !config?.gmailOAuth?.connected}
              className="px-4 py-2 bg-[#070b16] hover:bg-amber-500/10 disabled:opacity-50 text-amber-100 border border-amber-500/30 rounded-lg text-sm flex items-center gap-2"
            >
              <CheckCircle className="w-4 h-4" /> Check OAuth Token & Scopes
            </button>
            <button
              type="button"
              onClick={disconnectGmailOAuth}
              disabled={oauthBusy || !config?.gmailOAuth?.connected}
              className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-50 text-rose-200 border border-rose-500/30 rounded-lg text-sm flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" /> Disconnect & Revoke
            </button>
          </div>
          <p className="mt-3 text-xs text-amber-200/50">
            🔒 OAuth client secrets, access tokens, and refresh tokens are kept strictly server-side and encrypted with AES-256-GCM. Outbound sending remains blocked while EMAIL_SENDING_ENABLED=false.
          </p>
        </section>

        <form onSubmit={saveHostinger} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <h3 className="text-amber-50 font-medium mb-4 flex items-center gap-2"><Settings className="w-4 h-4" /> Hostinger SMTP / IMAP</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP Host" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="SMTP Port" type="number" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="SMTP Username (full email)" required className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="SMTP Password / App Password" type="password" required className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="IMAP Host" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="IMAP Port" type="number" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="IMAP Username (defaults to SMTP user)" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={imapPass} onChange={(e) => setImapPass(e.target.value)} placeholder="IMAP Password (defaults to SMTP pass)" type="password" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="From Name" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="From Email (defaults to SMTP user)" className="bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
          </div>
          <div className="text-amber-200/50 text-xs mt-3">
            🔒 Credentials are stored server-side in the encrypted database. Never committed to source code or frontend.
          </div>
          <button type="submit" disabled={saving} className="mt-4 px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center gap-2">
            <Save className="w-4 h-4" /> Save Hostinger Credentials
          </button>
        </form>

        <form onSubmit={saveLimits} className="bg-[#0e1424] border border-amber-500/10 rounded-2xl p-6">
          <h3 className="text-amber-50 font-medium mb-4">Sending Limits & Reply Draft Mode</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs uppercase tracking-wider text-amber-200/60 block mb-1.5">Daily Max</label>
              <input type="number" value={dailyMax} onChange={(e) => setDailyMax(e.target.value)} className="w-full bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-amber-200/60 block mb-1.5">Hourly Max</label>
              <input type="number" value={hourlyMax} onChange={(e) => setHourlyMax(e.target.value)} className="w-full bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none" />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-amber-200/60 block mb-1.5">Reply Draft Mode</label>
              <select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value)} className="w-full bg-[#070b16] border border-amber-500/20 rounded-lg px-3 py-2.5 text-amber-50 text-sm focus:outline-none">
                <option value="MANUAL">MANUAL (Draft review required)</option>
                <option value="SUPERVISED">SUPERVISED (Human-guided drafting)</option>
                <option value="AUTHORIZED_AUTOMATION">AUTHORIZED AUTOMATION (Automated drafting authorized; human approval required before send)</option>
              </select>
              <div className="mt-2 text-xs">
                {approvalMode === 'AUTHORIZED_AUTOMATION' ? (
                  <p className="text-emerald-300 font-medium">✓ Automation Authorized: AI drafts are automatically generated when replies arrive. Outbound email sending remains safely gated (human approval required before dispatch; EMAIL_SENDING_ENABLED=false).</p>
                ) : (
                  <p className="text-amber-200/50">Every response draft requires explicit human approval. Automated reply sending is unavailable.</p>
                )}
              </div>
            </div>
          </div>
          <button type="submit" disabled={saving} className="mt-4 px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold rounded-lg text-sm flex items-center gap-2">
            <Save className="w-4 h-4" /> Save Limits
          </button>
        </form>

        <div className="bg-[#0e1424] border border-rose-500/20 rounded-2xl p-6">
          <h3 className="text-rose-200 font-medium mb-2">Danger Zone</h3>
          <p className="text-rose-200/60 text-xs mb-4">
            Global purge is disabled because the existing schema does not prove dataset ownership. Dataset 9 and shared records are protected.
          </p>
          <button disabled title="Disabled during the forensic safety review" onClick={purgeData} className="px-4 py-2 bg-rose-500/10 text-rose-200/50 rounded-lg text-sm flex items-center gap-2 cursor-not-allowed">
            <Trash2 className="w-4 h-4" /> Purge Disabled
          </button>
        </div>
      </div>
    </>
  );
}
