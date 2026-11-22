import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, X } from 'lucide-react';

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="border border-dashed border-amber-500/20 rounded-2xl bg-[#0e1424]/50 p-12 text-center">
      {Icon && (
        <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-5">
          <Icon className="w-8 h-8 text-amber-400" />
        </div>
      )}
      <h3 className="text-xl font-semibold text-amber-50 mb-2">{title}</h3>
      {description && <p className="text-amber-200/60 max-w-md mx-auto mb-6 leading-relaxed">{description}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center py-16 gap-3 text-amber-200/70">
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="text-sm tracking-wide">{label}</span>
    </div>
  );
}

export function ErrorBanner({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 text-red-200 p-4 rounded-xl mb-4">
      <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div className="flex-1 text-sm">{error}</div>
      {onClose && (
        <button onClick={onClose} className="text-red-300 hover:text-red-100">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function StatCard({ label, value, sublabel, icon: Icon, accent = 'amber' }) {
  const accents = {
    amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30 text-amber-300',
    emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30 text-emerald-300',
    rose: 'from-rose-500/20 to-rose-500/5 border-rose-500/30 text-rose-300',
    sky: 'from-sky-500/20 to-sky-500/5 border-sky-500/30 text-sky-300',
    violet: 'from-violet-500/20 to-violet-500/5 border-violet-500/30 text-violet-300'
  };
  const style = accents[accent] || accents.amber;

  return (
    <div className={`bg-gradient-to-br ${style} border rounded-xl p-5 backdrop-blur-sm`}>
      <div className="flex items-start justify-between mb-3">
        <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
        {Icon && <Icon className="w-4 h-4 opacity-80" />}
      </div>
      <div className="text-3xl font-light text-white mb-1">{value}</div>
      {sublabel && <div className="text-xs opacity-60">{sublabel}</div>}
    </div>
  );
}

export function Pill({ label, color = 'amber' }) {
  const colors = {
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    sky: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    violet: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    slate: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30'
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full border ${colors[color] || colors.slate}`}>
      {label}
    </span>
  );
}

export function useFetch(url, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(r => r.json())
      .then(json => { if (!cancelled) { setData(json); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, deps);

  const refetch = () => {
    setLoading(true);
    setError(null);
    fetch(url)
      .then(r => r.json())
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  };

  return { data, loading, error, refetch };
}

export function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

export function formatMoney(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  const num = Number(amount);
  if (isNaN(num)) return '—';
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
