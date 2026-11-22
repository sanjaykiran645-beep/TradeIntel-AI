import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { googleAuthConfigured, signInWithGoogle } from '../lib/googleAuth';
import supabase, { supabaseConfigured } from '../lib/supabase';

export default function Login() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!loading && user) {
      navigate('/dashboard');
    }
  }, [user, loading, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);
    setError(null);

    try {
      if (!supabase) {
        throw new Error('Supabase authentication is not configured.');
      }

      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (result.error) {
        throw result.error;
      }

      navigate('/dashboard');
    } catch (err) {
      setError(
        err?.message ||
        'Unable to sign in. Please check your credentials and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070b16] flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-amber-600/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative w-full max-w-md">

        {/* BRAND */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center font-bold text-[#070b16] text-2xl">
              V
            </div>

            <div className="text-left">
              <div className="text-amber-50 text-lg font-semibold tracking-wider">
                TRADEINTEL AI
              </div>

              <div className="text-amber-200/50 text-[10px] uppercase tracking-widest">
                Voyage International Business
              </div>
            </div>
          </div>

          <p className="text-amber-200/60 text-sm">
            AI Email Intelligence · Research · Communication Agent
          </p>
        </div>

        {/* LOGIN CARD */}
        <div className="bg-[#0e1424] border border-amber-500/15 rounded-2xl p-7 shadow-2xl">

          <h2 className="text-amber-50 text-lg font-medium mb-1">
            Sign in
          </h2>

          <p className="text-amber-200/50 text-xs mb-6">
            Access the intelligence & communication console
          </p>

          {/* SUPABASE CONFIG WARNING */}
          {!supabaseConfigured && (
            <div
              role="alert"
              className="bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs p-3 rounded-lg mb-4"
            >
              Authentication is not configured. Add VITE_SUPABASE_URL and
              VITE_SUPABASE_ANON_KEY to your .env file, then restart the
              dev server.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* EMAIL */}
            <div>
              <label className="text-xs uppercase tracking-wider text-amber-200/60 block mb-1.5">
                Email
              </label>

              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />

                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full bg-[#070b16] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
                  placeholder="Enter your account email"
                />
              </div>
            </div>

            {/* PASSWORD */}
            <div>
              <label className="text-xs uppercase tracking-wider text-amber-200/60 block mb-1.5">
                Password
              </label>

              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400/60" />

                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full bg-[#070b16] border border-amber-500/20 focus:border-amber-400/60 rounded-lg pl-10 pr-3 py-2.5 text-amber-50 text-sm focus:outline-none"
                  placeholder="Enter your password"
                />
              </div>
            </div>

            {/* ERROR */}
            {error && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs p-3 rounded-lg">
                {error}
              </div>
            )}

            {/* SIGN IN */}
            <button
              type="submit"
              disabled={submitting || !supabaseConfigured}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#070b16] font-semibold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2"
            >
              {submitting && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}

              Sign In
            </button>

            {/* DIVIDER */}
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-amber-500/15"></div>

              <span className="text-[10px] text-amber-200/40 uppercase tracking-widest">
                or
              </span>

              <div className="flex-1 h-px bg-amber-500/15"></div>
            </div>

            {/* GOOGLE */}
            <button
              type="button"
              onClick={() => signInWithGoogle('TRADEINTEL AI')}
              disabled={!supabaseConfigured || !googleAuthConfigured}
              className="w-full bg-[#070b16] border border-amber-500/20 hover:bg-amber-500/5 text-amber-100 py-2.5 rounded-lg text-sm flex items-center justify-center gap-3"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />

                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />

                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />

                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>

              Sign in with Google
            </button>

            {!googleAuthConfigured && (
              <p className="text-center text-amber-200/50 text-xs">
                Google sign-in is not configured.
              </p>
            )}


          </form>
        </div>

        <div className="text-center mt-6 text-[10px] text-amber-200/40 uppercase tracking-widest">
          www.voyageib.com · info@voyageib.com
        </div>

      </div>
    </div>
  );
}
