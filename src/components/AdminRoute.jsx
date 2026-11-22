import { Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * AdminRoute protects routes that require an admin role.
 * It checks authentication and role, showing a loading spinner while auth is pending.
 * If the user is not admin, they are redirected to /dashboard.
 */
export default function AdminRoute() {
  const { user, loading, role } = useAuth();
  const outletContext = useOutletContext();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0a0f1c]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <div className="text-amber-200/70 text-sm tracking-widest uppercase">Authenticating</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // If user is not admin, redirect to dashboard.
  if (role !== 'admin') {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet context={outletContext} />;
}
