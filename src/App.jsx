import { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronRight, Clock, Files, HardDrive, LogOut, Menu, RotateCcw, Settings, Users } from 'lucide-react';
import { api } from './lib/api';
import { emptySettings } from './lib/settings';
import { useThemeMode } from './hooks/useThemeMode';
import { FullScreenState, NavItem, NotificationBell, StyledSelect, ThemeToggle } from './components/shared';
import AuthScreen from './views/AuthScreen';
import PvcView from './views/PvcView';
import SettingsView from './views/SettingsView';
import SchedulesView from './views/SchedulesView';
import RestoreView from './views/RestoreView';
import LogsView from './views/LogsView';
import UsersView from './views/UsersView';
import ProfileView from './views/ProfileView';
import LiveFilesView from './views/LiveFilesView';

const validTabs = new Set(['pvcs', 'schedules', 'restore', 'live-files', 'logs', 'users', 'settings', 'profile']);
const pathToTab = {
  '/': 'pvcs',
  '/pvcs': 'pvcs',
  '/schedules': 'schedules',
  '/restore': 'restore',
  '/live-files': 'live-files',
  '/logs': 'logs',
  '/users': 'users',
  '/settings': 'settings',
  '/profile': 'profile'
};

const tabToPath = {
  pvcs: '/pvcs',
  schedules: '/schedules',
  restore: '/restore',
  'live-files': '/live-files',
  logs: '/logs',
  users: '/users',
  settings: '/settings',
  profile: '/profile'
};

function initialTab() {
  const pathTab = pathToTab[window.location.pathname];
  const hashTab = window.location.hash.replace(/^#\/?/, '');
  const storedTab = window.localStorage.getItem('qbackup.activeTab');
  return pathTab || (validTabs.has(hashTab) ? hashTab : validTabs.has(storedTab) ? storedTab : 'pvcs');
}

export default function App() {
  const [theme, setTheme] = useThemeMode();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [settings, setSettings] = useState(emptySettings);
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationPeek, setNotificationPeek] = useState(null);
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const notify = useCallback((message, tone = 'info', title = tone === 'error' ? 'Action failed' : 'qbackup') => {
    const entry = {
      id: crypto.randomUUID(),
      title,
      message,
      tone,
      read: false,
      createdAt: new Date().toISOString()
    };
    setNotifications((prev) => [entry, ...prev].slice(0, 50));
    setNotificationPeek(entry);
    window.setTimeout(() => {
      setNotificationPeek((current) => current?.id === entry.id ? null : current);
    }, 4000);
  }, []);

  const refreshConfig = useCallback(async () => {
    const [config, serverStatus] = await Promise.all([api('/api/config'), api('/api/status')]);
    setSettings(config);
    setStatus(serverStatus);
  }, []);

  const loadSession = useCallback(async () => {
    setCheckingAuth(true);
    try {
      const me = await api('/api/auth/me');
      setUser(me.user);
      setNeedsSetup(false);
      await refreshConfig();
    } catch {
      setUser(null);
      const bootstrap = await api('/api/auth/bootstrap');
      setNeedsSetup(Boolean(bootstrap.needsSetup));
      setStatus(await api('/api/status'));
    } finally {
      setCheckingAuth(false);
    }
  }, [refreshConfig]);

  useEffect(() => {
    loadSession().catch((error) => {
      notify(error.message, 'error');
      setCheckingAuth(false);
    });
  }, [loadSession, notify]);

  useEffect(() => {
    window.localStorage.setItem('qbackup.activeTab', activeTab);
    const nextPath = tabToPath[activeTab] || '/pvcs';
    if (window.location.pathname !== nextPath || window.location.hash) {
      const nextUrl = `${nextPath}${window.location.search}`;
      window.history.replaceState(null, '', nextUrl);
    }
  }, [activeTab]);

  useEffect(() => {
    const syncRoute = () => {
      const pathTab = pathToTab[window.location.pathname];
      const hashTab = window.location.hash.replace(/^#\/?/, '');
      if (pathTab) setActiveTab(pathTab);
      else if (validTabs.has(hashTab)) setActiveTab(hashTab);
    };
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    };
  }, []);

  const startJobStream = useCallback((job) => {
    setJobs((prev) => [{ ...job, output: [] }, ...prev]);
    notify(`${job.type} job ${job.id.slice(0, 8)} started.`, 'info', 'Job started');
    const source = new EventSource(`/events/jobs/${job.id}`);
    source.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setJobs((prev) => prev.map((item) => item.id === update.id ? {
        ...item,
        ...update,
        output: [...(item.output || []), ...(update.output || [])]
      } : item));
      if (update.status !== 'running') {
        notify(`${update.type} job ${update.status}.`, update.status === 'succeeded' ? 'success' : 'error', update.status === 'succeeded' ? 'Job completed' : 'Job failed');
        source.close();
      }
    };
    source.onerror = () => {
      notify(`Lost live updates for ${job.type} job ${job.id.slice(0, 8)}.`, 'error', 'Job stream interrupted');
      source.close();
    };
  }, [notify]);

  const switchCluster = useCallback(async (clusterId) => {
    if (!clusterId || clusterId === settings.activeClusterId) return;
    try {
      const nextConfig = await api(`/api/clusters/${clusterId}/switch`, { method: 'POST' });
      setSettings(nextConfig);
      setJobs([]);
      notify(`Switched to ${nextConfig.clusterName || clusterId}.`, 'success', 'Cluster switched');
    } catch (error) {
      notify(error.message, 'error');
    }
  }, [notify, settings.activeClusterId]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
    setUser(null);
    setJobs([]);
    setActiveTab('pvcs');
    await loadSession();
  };

  const canUseLiveFiles = Boolean(settings.liveFileExplorerEnabled && user.permissions?.includes('files.manage'));

  if (checkingAuth) {
    return <FullScreenState title="qbackup" message="Checking session..." />;
  }

  if (!user) {
    return <AuthScreen needsSetup={needsSetup} onAuthenticated={(nextUser) => { setUser(nextUser); setNeedsSetup(false); refreshConfig().catch((error) => notify(error.message, 'error')); }} status={status} theme={theme} setTheme={setTheme} />;
  }

  return (
    <div className="qbackup-app flex h-screen text-slate-900 font-sans">
      <aside className={`${isSidebarOpen ? 'w-64' : 'w-20'} flex-shrink-0 hidden md:flex flex-col bg-[#0B101A] text-slate-300 transition-[width] duration-300 overflow-hidden border-r border-slate-800/60`}>
        <div className={`${isSidebarOpen ? 'justify-between px-6' : 'justify-center px-0'} h-16 flex items-center border-b border-slate-800/60`}>
          <div className={`${isSidebarOpen ? 'flex' : 'hidden'} items-center gap-2 overflow-hidden whitespace-nowrap`}>
            <div className="w-6 h-6 rounded-md bg-white flex items-center justify-center flex-shrink-0">
              <div className="w-3 h-3 bg-[#0B101A] rounded-sm" />
            </div>
            {isSidebarOpen && <span className="font-bold text-xl tracking-tight text-white">qbackup</span>}
          </div>
          <button onClick={() => setSidebarOpen((value) => !value)} className="w-9 h-9 inline-flex items-center justify-center rounded-lg border border-slate-700/60 text-slate-400 hover:text-white hover:bg-slate-800/70 transition-colors" title="Toggle sidebar">
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <nav className={`${isSidebarOpen ? 'px-3' : 'px-0 items-center'} flex-1 py-6 space-y-1 flex flex-col overflow-y-auto`}>
          <NavItem icon={<HardDrive />} label="PVCs & Backups" active={activeTab === 'pvcs'} onClick={() => setActiveTab('pvcs')} isOpen={isSidebarOpen} />
          <NavItem icon={<Clock />} label="Schedules" active={activeTab === 'schedules'} onClick={() => setActiveTab('schedules')} isOpen={isSidebarOpen} />
          <NavItem icon={<RotateCcw />} label="Restore" active={activeTab === 'restore'} onClick={() => setActiveTab('restore')} isOpen={isSidebarOpen} />
          {canUseLiveFiles && <NavItem icon={<Files />} label="Live Files" active={activeTab === 'live-files'} onClick={() => setActiveTab('live-files')} isOpen={isSidebarOpen} />}
          <NavItem icon={<Activity />} label="Audit Logs" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} isOpen={isSidebarOpen} />
          {user.permissions?.includes('users.manage') && <NavItem icon={<Users />} label="Users" active={activeTab === 'users'} onClick={() => setActiveTab('users')} isOpen={isSidebarOpen} />}
          <NavItem icon={<Settings />} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} isOpen={isSidebarOpen} />
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 border-b border-slate-800/60 bg-[#0A0E17]/80 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-10">
          <div className="flex items-center gap-4 min-w-0">
            <button onClick={() => setSidebarOpen((value) => !value)} className="md:hidden p-2 text-slate-400 hover:text-white">
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center text-sm font-medium text-slate-400 min-w-0">
              <span className="hover:text-slate-200 cursor-pointer transition-colors capitalize">{activeTab.replace('-', ' ')}</span>
              <ChevronRight className="w-4 h-4 mx-2 text-slate-600 flex-shrink-0" />
              <span className="text-white truncate">{settings.clusterName || 'cluster'}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="hidden sm:flex h-9 items-center gap-2 rounded-full border border-slate-800 bg-[#0B101A] pl-3 pr-2 text-xs text-slate-400">
              <span>Cluster</span>
              <StyledSelect
                value={settings.activeClusterId || settings.clusterId || ''}
                onChange={(event) => switchCluster(event.target.value)}
                className="qbackup-select-wrap--inline qbackup-select-wrap--pill max-w-44"
                title="Switch cluster"
                options={(settings.clusters?.length ? settings.clusters : [{ id: settings.activeClusterId || settings.clusterId || 'active', clusterName: settings.clusterName }]).map((cluster) => [cluster.id, cluster.clusterName || cluster.kubectlContext || cluster.id])}
              />
            </label>
            <ThemeToggle theme={theme} setTheme={setTheme} />
            <NotificationBell
              notifications={notifications}
              open={notificationOpen}
              setOpen={setNotificationOpen}
              markAllRead={() => setNotifications((prev) => prev.map((item) => ({ ...item, read: true })))}
              clearAll={() => setNotifications([])}
              dismissItem={(id) => setNotifications((prev) => prev.filter((item) => item.id !== id))}
              peek={notificationPeek}
              dismissPeek={() => setNotificationPeek(null)}
            />
            <div className="w-px h-5 bg-slate-800 mx-1 hidden sm:block" />
            <button onClick={() => setActiveTab('profile')} className="hidden md:flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full border border-slate-800 hover:bg-slate-800/50 transition-colors">
              <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center">
                <Users className="w-3 h-3 text-slate-300" />
              </div>
            <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{user.username}</span>
            </button>
            <button onClick={logout} className="p-2 rounded-full text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors" title="Logout"><LogOut className="w-4 h-4" /></button>
          </div>
        </header>

        <main key={settings.activeClusterId || settings.clusterId || settings.clusterName} className="flex-1 overflow-auto p-6">
          {activeTab === 'pvcs' && <PvcView settings={settings} notify={notify} startJobStream={startJobStream} />}
          {activeTab === 'settings' && <SettingsView settings={settings} setSettings={setSettings} notify={notify} refreshConfig={refreshConfig} />}
          {activeTab === 'schedules' && <SchedulesView settings={settings} notify={notify} />}
          {activeTab === 'restore' && <RestoreView notify={notify} startJobStream={startJobStream} />}
          {activeTab === 'live-files' && canUseLiveFiles && <LiveFilesView notify={notify} />}
          {activeTab === 'logs' && <LogsView jobs={jobs} canReadAudit={user.permissions?.includes('audit.read')} notify={notify} />}
          {activeTab === 'users' && user.permissions?.includes('users.manage') && <UsersView currentUser={user} notify={notify} />}
          {activeTab === 'profile' && <ProfileView user={user} setUser={setUser} notify={notify} />}
        </main>
      </div>

    </div>
  );
}
