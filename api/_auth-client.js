import { createClient } from '@supabase/supabase-js';

// Supabase remains the identity provider for the existing login/session flow.
// This client is intentionally separate from PostgreSQL table access.
const authUrl = String(process.env.SUPABASE_AUTH_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
const authKey = String(process.env.SUPABASE_AUTH_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const authConfigured = Boolean(authUrl && authKey);

const authClient = authConfigured
  ? createClient(authUrl, authKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

export default authClient;
