import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function AppShell() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  return (
    <div className="h-screen overflow-hidden bg-[#0a0f1c] flex">
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <div
        className={`${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0 fixed lg:static top-0 bottom-0 left-0 z-40 lg:z-auto transition-transform duration-200 ease-in-out w-64 flex-shrink-0 h-full bg-[#070b16] shadow-2xl lg:shadow-none`}
      >
        <Sidebar onNavigate={() => setMobileSidebarOpen(false)} />
      </div>
      <main className="flex-1 min-w-0 h-full overflow-y-auto">
        <Outlet context={{ mobileSidebarOpen, setMobileSidebarOpen }} />
      </main>
    </div>
  );
}
