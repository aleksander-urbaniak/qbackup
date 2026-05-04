import { useState } from 'react';
import { CheckCircle, Clock, Database, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import { CustomCheckbox, SelectField, SettingsPanel, TextField } from '../components/shared';

export default function SettingsView({ settings, setSettings, notify, refreshConfig }) {
  const [isSaved, setIsSaved] = useState(false);
  const [clusterModalOpen, setClusterModalOpen] = useState(false);
  const [clusterDraft, setClusterDraft] = useState({
    clusterName: '',
    kubectlContext: '',
    kubeconfigContent: '',
    nfsServer: settings.nfsServer || '',
    nfsExportPath: settings.nfsExportPath || '',
    backupRoot: settings.backupRoot || 'pvc-backups',
    helperImage: settings.helperImage || 'alpine:3.20',
    defaultSchedule: settings.defaultSchedule || '0 2 * * *',
    backupConcurrency: settings.backupConcurrency || '3',
    retentionDays: settings.retentionDays || '14',
    archiveExtension: settings.archiveExtension || 'tgz',
    localNfsPreflight: settings.localNfsPreflight || 'mount'
  });
  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    setSettings((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };
  const handleSave = async (event) => {
    event.preventDefault();
    try {
      const saved = await api('/api/config', { method: 'PUT', body: JSON.stringify(settings) });
      setSettings(saved);
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 3000);
      await refreshConfig();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const switchCluster = async (clusterId) => {
    try {
      const saved = await api(`/api/clusters/${clusterId}/switch`, { method: 'POST' });
      setSettings(saved);
      notify(`Switched to ${saved.clusterName || clusterId}.`, 'success', 'Cluster switched');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const deleteCluster = async (clusterId) => {
    try {
      const saved = await api(`/api/clusters/${clusterId}`, { method: 'DELETE' });
      setSettings(saved);
      notify('Cluster removed.');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const createCluster = async (event) => {
    event.preventDefault();
    try {
      const saved = await api('/api/clusters', { method: 'POST', body: JSON.stringify(clusterDraft) });
      setSettings(saved);
      setClusterModalOpen(false);
      notify(`Cluster ${saved.clusterName} added.`, 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  return (
    <div className="max-w-[1400px] w-full mx-auto pb-12">
      <div className="mb-6"><h1 className="text-2xl font-bold text-slate-800">Configuration</h1><p className="text-slate-500 text-sm mt-1">Manage global settings for NFS targets and backup behavior.</p></div>
      <div className="space-y-8">
        <SettingsPanel icon={<Database />} title="Clusters">
          <div className="md:col-span-2 space-y-3">
            {(settings.clusters || []).length === 0 && (
              <div className="rounded-lg border border-slate-800/80 bg-[#05080f] p-5 text-sm text-slate-400">
                No clusters configured yet. Add the first cluster to start listing PVCs, creating schedules, and running backups.
              </div>
            )}
            {(settings.clusters || []).map((cluster) => (
              <div key={cluster.id} className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${cluster.id === settings.activeClusterId ? 'border-blue-500/30 bg-blue-500/10' : 'border-slate-800/80 bg-[#05080f]'}`}>
                <div>
                  <div className="font-medium text-slate-200">{cluster.clusterName || cluster.id}</div>
                  <div className="mt-1 text-xs text-slate-400">{cluster.kubectlContext || 'current kube context'}{cluster.hasKubeconfig ? ' · managed kubeconfig' : ''} · {cluster.nfsServer}:{cluster.nfsExportPath}</div>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={cluster.id === settings.activeClusterId} onClick={() => switchCluster(cluster.id)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40">Switch</button>
                  <button type="button" onClick={() => deleteCluster(cluster.id)} className="rounded-lg border border-red-500/20 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10">Delete</button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setClusterModalOpen(true)} className="qbackup-primary-white rounded-lg px-4 py-2 text-sm font-medium">Add Cluster</button>
          </div>
        </SettingsPanel>

      <form onSubmit={handleSave} className="space-y-8">
        <SettingsPanel icon={<HardDrive />} title="NFS Storage Target">
          <TextField label="NFS Server (IP/Hostname)" name="nfsServer" value={settings.nfsServer} onChange={handleChange} />
          <TextField label="Export Path" name="nfsExportPath" value={settings.nfsExportPath} onChange={handleChange} />
          <TextField label="Backup Root Directory" name="backupRoot" value={settings.backupRoot} onChange={handleChange} />
          <TextField label="Archive Extension" name="archiveExtension" value={settings.archiveExtension} onChange={handleChange} />
        </SettingsPanel>
        <SettingsPanel icon={<Database />} title="Kubernetes Environment">
          <TextField label="Kubectl Context" name="kubectlContext" value={settings.kubectlContext} onChange={handleChange} placeholder="Blank uses current context" />
          <TextField label="Cluster Name" name="clusterName" value={settings.clusterName} onChange={handleChange} />
          <label className="md:col-span-2 block">
            <span className="block text-sm font-medium text-slate-700 mb-1">Kubeconfig YAML</span>
            <textarea
              name="kubeconfigContent"
              value={settings.kubeconfigContent || ''}
              onChange={handleChange}
              placeholder="Optional. Paste a full kubeconfig here if qbackup should manage this cluster connection."
              className="h-36 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
            <span className="mt-1 block text-xs text-slate-500">Do not paste kubeconfig YAML into Kubectl Context. Context is only the context name, for example default.</span>
          </label>
          <TextField label="Helper Image" name="helperImage" value={settings.helperImage} onChange={handleChange} />
          <SelectField label="Local NFS Preflight" name="localNfsPreflight" value={settings.localNfsPreflight} onChange={handleChange} options={[['mount', 'Mount locally before backup'], ['skip', 'Skip local mount check']]} />
          <label className="col-span-full flex items-center gap-3 p-4 border border-slate-800/80 bg-[#05080f] rounded-lg cursor-pointer hover:bg-slate-800/40 hover:border-slate-700 transition-colors">
            <CustomCheckbox checked={settings.scaleConsumers} onChange={() => handleChange({ target: { name: 'scaleConsumers', type: 'checkbox', checked: !settings.scaleConsumers } })} ariaLabel="Scale consumers to zero during backup" />
            <div><div className="font-medium text-slate-200 text-sm">Scale consumers to zero during backup</div><div className="text-xs text-slate-400">Used by qbackup backup and restore workflows.</div></div>
          </label>
          <label className="col-span-full flex items-center gap-3 p-4 border border-slate-800/80 bg-[#05080f] rounded-lg cursor-pointer hover:bg-slate-800/40 hover:border-slate-700 transition-colors">
            <CustomCheckbox checked={settings.keepFailedPods} onChange={() => handleChange({ target: { name: 'keepFailedPods', type: 'checkbox', checked: !settings.keepFailedPods } })} ariaLabel="Keep failed helper Pods" />
            <div><div className="font-medium text-slate-200 text-sm">Keep failed helper Pods</div><div className="text-xs text-slate-400">Preserves failed Pods for diagnostics after backup or restore operations.</div></div>
          </label>
        </SettingsPanel>
        <SettingsPanel icon={<Clock />} title="Scheduling & Retention Defaults">
          <TextField label="Default Cron Schedule" name="defaultSchedule" value={settings.defaultSchedule} onChange={handleChange} mono />
          <TextField label="Parallel Backups" name="backupConcurrency" value={settings.backupConcurrency} onChange={handleChange} type="number" />
          <TextField label="Retention Days (0 to disable)" name="retentionDays" value={settings.retentionDays} onChange={handleChange} type="number" />
          <div className="md:col-span-2 text-xs text-slate-500 -mt-3">Limits how many selected PVC backups qbackup runs at the same time. Use 1 for safest cluster and storage load.</div>
        </SettingsPanel>
        <div className="flex items-center justify-end pt-4 gap-4">
          <div className="flex items-center gap-4">{isSaved && <span className="text-emerald-600 text-sm font-medium flex items-center gap-1"><CheckCircle className="w-4 h-4" /> Saved</span>}<button disabled={(settings.clusters || []).length === 0} type="submit" className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40">Save Configuration</button></div>
        </div>
      </form>
      </div>
      {clusterModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <form onSubmit={createCluster} className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-800 bg-[#0B101A] shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/30 px-6 py-4">
              <h2 className="text-lg font-semibold text-white">Add Cluster</h2>
              <button type="button" onClick={() => setClusterModalOpen(false)} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white">Close</button>
            </div>
            <div className="grid max-h-[70vh] grid-cols-1 gap-5 overflow-auto p-6 md:grid-cols-2">
              <TextField label="Cluster Name" name="clusterName" value={clusterDraft.clusterName} onChange={(event) => setClusterDraft({ ...clusterDraft, clusterName: event.target.value })} />
              <TextField label="Kubectl Context" name="kubectlContext" value={clusterDraft.kubectlContext} onChange={(event) => setClusterDraft({ ...clusterDraft, kubectlContext: event.target.value })} placeholder="Blank uses current context" />
              <label className="md:col-span-2 block">
                <span className="block text-sm font-medium text-slate-700 mb-1">Kubeconfig YAML</span>
                <textarea
                  value={clusterDraft.kubeconfigContent}
                  onChange={(event) => setClusterDraft({ ...clusterDraft, kubeconfigContent: event.target.value })}
                  placeholder="Optional. Paste a full kubeconfig here if this cluster is not available through the current kubectl config."
                  className="h-40 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
                <span className="mt-1 block text-xs text-slate-500">Kubectl Context is a name only. If you paste kubeconfig YAML, put it in this box.</span>
              </label>
              <TextField label="NFS Server" name="nfsServer" value={clusterDraft.nfsServer} onChange={(event) => setClusterDraft({ ...clusterDraft, nfsServer: event.target.value })} />
              <TextField label="Export Path" name="nfsExportPath" value={clusterDraft.nfsExportPath} onChange={(event) => setClusterDraft({ ...clusterDraft, nfsExportPath: event.target.value })} />
              <TextField label="Backup Root" name="backupRoot" value={clusterDraft.backupRoot} onChange={(event) => setClusterDraft({ ...clusterDraft, backupRoot: event.target.value })} />
              <TextField label="Helper Image" name="helperImage" value={clusterDraft.helperImage} onChange={(event) => setClusterDraft({ ...clusterDraft, helperImage: event.target.value })} />
              <TextField label="Default Schedule" name="defaultSchedule" value={clusterDraft.defaultSchedule} onChange={(event) => setClusterDraft({ ...clusterDraft, defaultSchedule: event.target.value })} mono />
              <TextField label="Parallel Backups" name="backupConcurrency" type="number" value={clusterDraft.backupConcurrency} onChange={(event) => setClusterDraft({ ...clusterDraft, backupConcurrency: event.target.value })} />
              <TextField label="Retention Days" name="retentionDays" type="number" value={clusterDraft.retentionDays} onChange={(event) => setClusterDraft({ ...clusterDraft, retentionDays: event.target.value })} />
              <TextField label="Archive Extension" name="archiveExtension" value={clusterDraft.archiveExtension} onChange={(event) => setClusterDraft({ ...clusterDraft, archiveExtension: event.target.value })} />
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-800/80 bg-slate-900/30 px-6 py-4">
              <button type="button" onClick={() => setClusterModalOpen(false)} className="rounded-xl px-5 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white">Cancel</button>
              <button className="qbackup-primary-white rounded-xl px-6 py-2.5 text-sm font-medium">Create Cluster</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
