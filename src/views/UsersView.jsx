import { useCallback, useEffect, useState } from 'react';
import { KeyRound, MoreHorizontal, Plus, Search, Shield, Trash2, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import { tableBodyClass } from '../lib/tableClasses';
import { DarkField, EmptyRow, StyledSelect } from '../components/shared';

export default function UsersView({ currentUser, notify }) {
  const [users, setUsers] = useState([]);
  const [draft, setDraft] = useState({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'viewer' });
  const [passwords, setPasswords] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/users');
      setUsers(data.users || []);
    } catch (error) {
      notify(error.message, 'error');
    }
  }, [notify]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (event) => {
    event.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'viewer' });
      notify('User created.');
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const patchUser = async (id, payload) => {
    try {
      await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('User updated.');
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const deleteUser = async (id) => {
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      notify('User deleted.');
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const filteredUsers = users.filter((entry) => `${entry.username} ${entry.firstName} ${entry.lastName} ${entry.email} ${entry.role}`.toLowerCase().includes(searchQuery.toLowerCase()));
  const initials = (entry) => `${entry.firstName?.[0] || entry.username?.[0] || 'U'}${entry.lastName?.[0] || ''}`.toUpperCase();
  const displayName = (entry) => [entry.firstName, entry.lastName].filter(Boolean).join(' ') || '-';
  const avatarColor = (index) => ['from-blue-500 to-indigo-600', 'from-emerald-400 to-teal-500', 'from-purple-500 to-pink-500', 'from-amber-400 to-orange-500', 'from-cyan-400 to-blue-500'][index % 5];

  return (
    <div className="max-w-[1400px] w-full mx-auto">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">User Management</h1>
          <p className="text-sm text-slate-400">Manage local accounts, roles, and system access.</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative group">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-white transition-colors" />
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="bg-[#0B101A] border border-slate-700/60 text-sm rounded-lg pl-9 pr-4 py-2 w-full sm:w-64 text-slate-200 focus:outline-none focus:border-white/50 focus:ring-1 focus:ring-white/30 transition-all placeholder:text-slate-600"
            />
          </div>
          <button onClick={() => setIsAddModalOpen(true)} className="qbackup-primary-white inline-flex items-center justify-center gap-2 text-sm font-medium px-4 py-2 rounded-lg transition-all">
            <Plus className="w-4 h-4" />
            Add User
          </button>
        </div>
      </div>

      <div className="bg-[#0B101A] border border-slate-800/80 rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 bg-[#0A0E17]/50">
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Avatar</th>
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">User ID</th>
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Email</th>
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Role</th>
                <th className="px-6 py-5 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {filteredUsers.map((entry, index) => (
                <tr key={entry.id} className="group transition-colors hover:bg-slate-800/20">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-tr ${avatarColor(index)} flex items-center justify-center shrink-0 shadow-lg`}>
                      <span className="text-sm font-bold text-white shadow-sm">{initials(entry)}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap"><span className="text-sm font-semibold text-slate-200">{entry.username}</span></td>
                  <td className="px-6 py-4 whitespace-nowrap"><span className="text-sm text-slate-300">{displayName(entry)}</span></td>
                  <td className="px-6 py-4 whitespace-nowrap"><span className="text-sm text-slate-400">{entry.email || '-'}</span></td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Shield className={`w-4 h-4 ${entry.role === 'admin' ? 'text-purple-400' : 'text-slate-500'}`} />
                      <StyledSelect
                        value={entry.role}
                        onChange={(event) => patchUser(entry.id, { role: event.target.value })}
                        className="qbackup-select-wrap--inline min-w-36"
                        options={['viewer', 'operator', 'manager', 'auditor', 'admin'].map((role) => [role, role])}
                      />
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setPasswordUser(entry)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all" title="Change Password">
                        <KeyRound className="w-4 h-4" />
                      </button>
                      <button onClick={() => deleteUser(entry.id)} disabled={entry.id === currentUser.id} className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all disabled:opacity-30" title="Delete User">
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all md:hidden">
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && <EmptyRow colSpan={6} icon={<Users />} text="No users found." />}
            </tbody>
          </table>
        </div>
      </div>

      {passwordUser && (
        <ChangePasswordModal
          user={passwordUser}
          value={passwords[passwordUser.id] || ''}
          onChange={(value) => setPasswords({ ...passwords, [passwordUser.id]: value })}
          onClose={() => setPasswordUser(null)}
          onSave={() => {
            patchUser(passwordUser.id, { password: passwords[passwordUser.id] });
            setPasswords({ ...passwords, [passwordUser.id]: '' });
            setPasswordUser(null);
          }}
        />
      )}

      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0B101A] border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/30">
              <h2 className="text-lg font-semibold text-white">Create New User</h2>
              <button onClick={() => setIsAddModalOpen(false)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={create}>
              <div className="p-6 overflow-y-auto max-h-[70vh] flex flex-col gap-5">
                <DarkField label="Username *" value={draft.username} onChange={(value) => setDraft({ ...draft, username: value })} placeholder="e.g. jsmith" />
                <div className="grid grid-cols-2 gap-4">
                  <DarkField label="First Name" value={draft.firstName} onChange={(value) => setDraft({ ...draft, firstName: value })} placeholder="John" />
                  <DarkField label="Last Name" value={draft.lastName} onChange={(value) => setDraft({ ...draft, lastName: value })} placeholder="Smith" />
                </div>
                <DarkField label="Email Address" type="email" value={draft.email} onChange={(value) => setDraft({ ...draft, email: value })} placeholder="john.smith@example.com" />
                <div className="pt-2 border-t border-slate-800/80">
                  <DarkField label="Initial Password *" type="password" value={draft.password} onChange={(value) => setDraft({ ...draft, password: value })} placeholder="Enter initial password" />
                </div>
                <label>
                  <span className="block text-xs font-medium text-slate-400 mb-1.5">System Role</span>
                  <div className="relative">
                    <StyledSelect
                      value={draft.role}
                      onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                      options={['viewer', 'operator', 'manager', 'auditor', 'admin'].map((role) => [role, role])}
                    />
                  </div>
                </label>
              </div>
              <div className="px-6 py-4 border-t border-slate-800/80 bg-slate-900/30 flex items-center justify-end gap-3">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors">Cancel</button>
                <button className="qbackup-primary-white px-6 py-2 text-sm font-medium rounded-xl transition-all">Create User</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ChangePasswordModal({ user, value, onChange, onClose, onSave }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0B101A] border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/30">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Change Password</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">User</label>
            <div className="w-full bg-[#05080f] border border-slate-800/80 text-sm rounded-xl px-4 py-3 font-mono text-slate-400">
              {user.username}
            </div>
          </div>
          <DarkField label="New Password" type="password" value={value} onChange={onChange} placeholder="Enter new password" />
        </div>

        <div className="px-6 py-4 border-t border-slate-800/80 bg-slate-900/30 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all">Cancel</button>
          <button disabled={!value} onClick={onSave} className="qbackup-primary-white px-6 py-2.5 text-sm font-medium rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed">Save</button>
        </div>
      </div>
    </div>
  );
}
