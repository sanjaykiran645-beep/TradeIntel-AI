import { createContext, useContext, useEffect, useState } from 'react';
import supabase from '../lib/supabase';
import { AUTH_SESSION_INVALIDATED_EVENT, signOutOrThrow } from '../lib/api-auth-errors';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const role = user?.app_metadata?.role === 'admin' ? 'admin' : 'user';

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const handleSessionInvalidated = () => {
      setSession(null);
      setUser(null);
    };
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
      window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);
    };
  }, []);

  const signOut = async () => {
    if (!supabase) throw new Error('Supabase authentication is not configured.');
    await signOutOrThrow(() => supabase.auth.signOut());
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        role,
        loading,
        signOut
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
