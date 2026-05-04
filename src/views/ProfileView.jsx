import { useState } from 'react';
import { api } from '../lib/api';
import { TextField } from '../components/shared';

export default function ProfileView({ user, setUser, notify }) {
  const [draft, setDraft] = useState({ username: user.username, firstName: user.firstName, lastName: user.lastName, email: user.email, password: '' });
  const save = async (event) => {
    event.preventDefault();
    try {
      const payload = { ...draft, password: draft.password || undefined };
      const data = await api('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(payload) });
      setUser(data.user);
      setDraft((prev) => ({ ...prev, password: '' }));
      notify('Profile updated.');
    } catch (error) {
      notify(error.message, 'error');
    }
  };
  return (
    <div className="max-w-[1400px] w-full mx-auto">
      <div className="mb-6"><h1 className="text-2xl font-bold text-slate-800">Profile</h1><p className="text-slate-500 text-sm mt-1">Update your local account details.</p></div>
      <form onSubmit={save} className="bg-white rounded-lg border border-slate-200 shadow-sm p-6 grid grid-cols-1 md:grid-cols-2 gap-5">
        <TextField label="Username" name="username" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
        <TextField label="Email" name="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
        <TextField label="First Name" name="firstName" value={draft.firstName} onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} />
        <TextField label="Last Name" name="lastName" value={draft.lastName} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} />
        <div className="md:col-span-2"><TextField label="New Password" name="password" type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder="Leave blank to keep current password" /></div>
        <div className="md:col-span-2 flex justify-end"><button className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700">Save Profile</button></div>
      </form>
    </div>
  );
}
