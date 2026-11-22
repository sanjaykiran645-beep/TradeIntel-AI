import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  LayoutDashboard, Database, Building2, Package, Globe2,
  Search, Users, Mail, Inbox, MessageSquare, Repeat,
  Target, Briefcase, Settings, LogOut, Shield
} from 'lucide-react';

export default function Sidebar({ onNavigate }) {
  const { user, role, signOut } = useAuth();
  const navigate = useNavigate();
  const [signOutError, setSignOutError] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      setSignOutError(error?.message || 'Unable to sign out. Please try again.');
    } finally {
      setSigningOut(false);
    }
  };

  // Explicit section arrays (no positional slicing). Order, icons and labels are
  // unchanged from the previous flat list; admin-only links are appended to System.
  const intelligenceLinks = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/import', icon: Database, label: 'Import Data' },
    { to: '/companies', icon: Building2, label: 'Companies' },
    { to: '/products', icon: Package, label: 'Products' },
    { to: '/markets', icon: Globe2, label: 'Markets' },
    { to: '/research', icon: Search, label: 'Research' },
    { to: '/contacts', icon: Users, label: 'Contacts' }
  ];

  const communicationLinks = [
    { to: '/opportunities', icon: Briefcase, label: 'Opportunities' },
    { to: '/outreach', icon: Mail, label: 'Outreach' },
    { to: '/inbox', icon: Inbox, label: 'Hostinger Inbox' },
    { to: '/responses', icon: MessageSquare, label: 'Responses' },
    { to: '/followups', icon: Repeat, label: 'Follow-ups' },
    { to: '/leads', icon: Target, label: 'Leads' }
  ];

  const baseSystemLinks = [
    { to: '/customer360', icon: Building2, label: 'Customer 360' }
  ];

  const adminLinks = [
    { to: '/reports', icon: Shield, label: 'Audit & Reports' },
    { to: '/admin', icon: Settings, label: 'Admin Settings' }
  ];

  // Admin-only visibility is a UI convenience; the server enforces access in api/_utils.js.
  const systemLinks = role === 'admin' ? [...baseSystemLinks, ...adminLinks] : baseSystemLinks;


  return (
    <aside className="flex flex-col h-full w-64 bg-[#070b16] border-r border-amber-500/10">
      <div className="p-6 border-b border-amber-500/10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center font-bold text-[#070b16] text-lg">
            V
          </div>
          <div>
            <div className="text-amber-50 font-semibold text-sm tracking-wider">TRADEINTEL AI</div>
            <div className="text-amber-200/50 text-[10px] uppercase tracking-widest">Voyage IB</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
        {[ { title: 'Intelligence', links: intelligenceLinks },
           { title: 'Communication', links: communicationLinks },
           { title: 'System', links: systemLinks } ].map((group, idx) => (
          <React.Fragment key={idx}>
            <div className="px-3 mt-6 mb-2 text-[10px] uppercase tracking-widest text-amber-200/40 px-4">{group.title}</div>
            {group.links.map(link => (
              <NavLink key={link.to} to={link.to} onClick={() => onNavigate && onNavigate()} className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors ${isActive
                  ? 'bg-amber-500/15 text-amber-200 border-l-2 border-amber-400 font-medium'
                  : 'text-amber-200/60 hover:bg-amber-500/5 hover:text-amber-100'}`
              }>
                <link.icon className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{link.label}</span>
              </NavLink>
            ))}
          </React.Fragment>
        ))}
      </nav>

      <div className="p-4 border-t border-amber-500/10">
        {signOutError && <div role="alert" className="mb-3 text-xs text-rose-300">{signOutError}</div>}
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-300 text-xs font-semibold">
            {user?.email?.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-amber-100 text-xs truncate">{user?.email}</div>
            <div className="text-amber-200/40 text-[10px] uppercase">{role}</div>
          </div>
        </div>
        <button onClick={handleSignOut} disabled={signingOut}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-amber-500/5 hover:bg-amber-500/15 text-amber-300 text-xs transition-colors">
          <LogOut className="w-3.5 h-3.5" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
