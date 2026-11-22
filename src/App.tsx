import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import AppShell from './components/AppShell';
import { LoadingState } from './components/UI';
import { handleGoogleRedirect } from './lib/googleAuth';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ImportData = lazy(() => import('./pages/ImportData'));
const Companies = lazy(() => import('./pages/Companies'));
const Products = lazy(() => import('./pages/Products'));
const Markets = lazy(() => import('./pages/Markets'));
const Research = lazy(() => import('./pages/Research'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Outreach = lazy(() => import('./pages/Outreach'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Responses = lazy(() => import('./pages/Responses'));
const Followups = lazy(() => import('./pages/Followups'));
const Leads = lazy(() => import('./pages/Leads'));
const Opportunities = lazy(() => import('./pages/Opportunities'));
const Customer360 = lazy(() => import('./pages/Customer360'));
const Reports = lazy(() => import('./pages/Reports'));
const Admin = lazy(() => import('./pages/Admin'));

handleGoogleRedirect();

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <LoadingState label="Loading workspace..." />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/import" element={<ImportData />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/products" element={<Products />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/research" element={<Research />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/outreach" element={<Outreach />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/responses" element={<Responses />} />
              <Route path="/followups" element={<Followups />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/opportunities" element={<Opportunities />} />
              <Route path="/customer360" element={<Customer360 />} />
              <Route element={<AdminRoute />}>
                <Route path="/reports" element={<Reports />} />
                <Route path="/admin" element={<Admin />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
