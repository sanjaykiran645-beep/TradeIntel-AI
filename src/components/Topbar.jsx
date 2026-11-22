import { Menu, X } from 'lucide-react';

export default function Topbar({ title, subtitle, actions, mobileSidebarOpen, setMobileSidebarOpen }) {

  return (
    <header className="bg-[#0a0f1c] border-b border-amber-500/10 px-4 lg:px-8 py-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
            className="lg:hidden p-2 text-amber-300 hover:bg-amber-500/10 rounded-lg"
          >
            {mobileSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="min-w-0">
            <h1 className="text-xl lg:text-2xl font-light text-amber-50 truncate">{title}</h1>
            {subtitle && <p className="text-amber-200/50 text-xs lg:text-sm mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {actions}
        </div>
      </div>
    </header>
  );
}
