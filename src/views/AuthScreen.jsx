import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { TextField } from '../components/shared';

export default function AuthScreen({ needsSetup, onAuthenticated }) {
  const [mode, setMode] = useState(needsSetup ? 'setup' : 'login');
  const [form, setForm] = useState({
    username: '',
    password: '',
    firstName: '',
    lastName: '',
    email: ''
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setMode(needsSetup ? 'setup' : 'login'), [needsSetup]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'setup' ? '/api/auth/bootstrap' : '/api/auth/login';
      const data = await api(path, { method: 'POST', body: JSON.stringify(form) });
      onAuthenticated(data.user);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qbackup-auth min-h-screen flex items-center justify-center p-6">
      <main className="w-full max-w-md">
        <form onSubmit={submit} className="bg-white text-slate-900 p-8 lg:p-10 flex flex-col justify-center border border-slate-800 shadow-2xl rounded-lg">
          <div className="mb-7 text-center">
            <div className="flex flex-col items-center gap-3 mb-6">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent))] text-[rgb(var(--on-accent-text))] shadow-[0_0_20px_rgb(var(--accent)/0.32)]">
                <ShieldCheck className="w-6 h-6" />
              </span>
              <span className="text-xl font-bold uppercase tracking-[0.08em]">qbackup</span>
            </div>
            <h2 className="text-2xl font-bold tracking-tight">{mode === 'setup' ? 'Create admin account' : 'Sign in'}</h2>
            <p className="text-sm text-slate-500 mt-1">{mode === 'setup' ? 'First run setup for this backup console.' : 'Use a local account managed by an admin.'}</p>
          </div>
          <div className="space-y-4">
            {mode === 'setup' && (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="First Name" name="firstName" value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
                <TextField label="Last Name" name="lastName" value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
              </div>
            )}
            <TextField label="Username" name="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            {mode === 'setup' && <TextField label="Email" name="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />}
            <TextField label="Password" name="password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </div>
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
          <button disabled={busy} type="submit" className="mt-6 w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-60">
            {busy ? 'Working...' : mode === 'setup' ? 'Create Admin' : 'Sign In'}
          </button>
        </form>
      </main>
    </div>
  );
}
