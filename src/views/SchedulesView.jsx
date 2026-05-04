import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Clock, HardDrive, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { tableActionGroupClass, tableBodyClass, tableButtonClass, tableClass, tableHeadClass, tableHeadRowClass, tableShellClass, tableTdActionClass, tableTdClass, tableThActionClass, tableThClass, tableRowClass } from '../lib/tableClasses';
import { CustomCheckbox, EmptyRow, StatusBadge } from '../components/shared';
import { EditScheduleModal, ScheduleModal } from '../components/ScheduleModal';

export default function SchedulesView({ settings, notify }) {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState([]);
  const [pvcs, setPvcs] = useState([]);
  const selectedJobs = schedules.filter((job) => selected.includes(job.id));
  const allVisibleSelected = schedules.length > 0 && schedules.every((job) => selected.includes(job.id));

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [scheduleRows, pvcRows] = await Promise.all([api('/api/schedules'), api('/api/pvcs')]);
      setSchedules(scheduleRows);
      setPvcs(pvcRows);
      setSelected((prev) => prev.filter((id) => scheduleRows.some((job) => job.id === id)));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const action = async (promise, message) => {
    try {
      await promise;
      notify(message);
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const bulkAction = async (factory, message) => {
    if (selectedJobs.length === 0) return;
    try {
      await Promise.all(selectedJobs.map(factory));
      notify(message);
      setSelected([]);
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const toggleSelect = (id) => setSelected((prev) => prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]);
  const toggleAll = () => setSelected(allVisibleSelected ? [] : schedules.map((job) => job.id));

  return (
    <div className="flex flex-col h-full min-h-0 max-w-[1400px] w-full mx-auto">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">Backup Schedules</h1>
          <p className="text-sm text-slate-400">Automate your volume backups with cron expressions.</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refresh} className="p-2 border border-slate-700/60 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 hover:border-slate-600 transition-all" title="Refresh schedules"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => setNewOpen(true)} className="qbackup-primary-white inline-flex items-center justify-center gap-2 text-sm font-medium px-4 py-2 rounded-lg transition-all"><Plus className="w-4 h-4" /> Create Schedule</button>
        </div>
      </div>
      <div className={`${tableShellClass} flex-1 min-h-0 flex flex-col`}>
        <div className={`min-h-[58px] border-b px-6 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 transition-colors ${selectedJobs.length > 0 ? 'bg-blue-500/10 border-blue-500/20' : 'bg-slate-900/30 border-slate-800/80'}`}>
          <span className={`text-sm font-medium transition-colors ${selectedJobs.length > 0 ? 'text-blue-300' : 'text-slate-500'}`}>
            {selectedJobs.length > 0 ? `${selectedJobs.length} schedule(s) selected` : 'Select schedules for bulk actions'}
          </span>
          <div className={`flex flex-wrap gap-2 transition-opacity ${selectedJobs.length > 0 ? 'opacity-100' : 'opacity-40'}`}>
            <button disabled={selectedJobs.length === 0} onClick={() => bulkAction((job) => api(`/api/schedules/${job.namespace}/${job.name}/run`, { method: 'POST' }), 'Manual jobs created.')} className={tableButtonClass}><Play className="w-3.5 h-3.5 mr-1" /> Run Now</button>
            <button disabled={selectedJobs.length === 0} onClick={() => setEditing(selectedJobs)} className={tableButtonClass}><Pencil className="w-3.5 h-3.5 mr-1" /> Edit</button>
            <button disabled={selectedJobs.length === 0} onClick={() => bulkAction((job) => api(`/api/schedules/${job.namespace}/${job.name}`, { method: 'PATCH', body: JSON.stringify({ suspended: true }) }), 'Schedules suspended.')} className={tableButtonClass} title="Pause selected schedules"><Pause className="w-3.5 h-3.5" /></button>
            <button disabled={selectedJobs.length === 0} onClick={() => bulkAction((job) => api(`/api/schedules/${job.namespace}/${job.name}`, { method: 'PATCH', body: JSON.stringify({ suspended: false }) }), 'Schedules resumed.')} className={tableButtonClass} title="Resume selected schedules"><Play className="w-3.5 h-3.5" /></button>
            <button disabled={selectedJobs.length === 0} onClick={() => bulkAction((job) => api(`/api/schedules/${job.namespace}/${job.name}`, { method: 'DELETE' }), 'Schedules deleted.')} className="inline-flex items-center justify-center text-xs font-medium px-3 py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5 mr-1" /> Delete</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
        <table className={tableClass}>
          <thead className={tableHeadClass}><tr className={tableHeadRowClass}><th className="px-6 py-4 w-12"><CustomCheckbox checked={allVisibleSelected} indeterminate={selected.length > 0 && !allVisibleSelected} onChange={toggleAll} ariaLabel="Select all schedules" /></th><th className={tableThClass}>Schedule (Cron)</th><th className={tableThClass}>Targets</th><th className={tableThClass}>Last Run</th><th className={tableThClass}>Status</th><th className={tableThActionClass}>Actions</th></tr></thead>
          <tbody className={tableBodyClass}>
            {schedules.map((job) => (
              <tr key={job.id} className={`${tableRowClass} ${selected.includes(job.id) ? 'bg-blue-500/5 hover:bg-blue-500/10' : ''}`}>
                <td className="px-6 py-3.5 whitespace-nowrap">
                  <CustomCheckbox checked={selected.includes(job.id)} onChange={() => toggleSelect(job.id)} ariaLabel={`Select ${job.name}`} />
                </td>
                <td className="px-4 py-3.5 whitespace-nowrap">
                  <div className="flex items-center gap-3">
                    <CalendarDays className="w-4 h-4 text-slate-500" />
                    <code className="bg-slate-900 border border-slate-800 px-2 py-1 rounded-md text-sm font-mono text-slate-200">{job.schedule}</code>
                  </div>
                </td>
                <td className={tableTdClass}>
                  <span className="inline-flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-400">{job.namespace}/{job.pvc}</span>
                  </span>
                </td>
                <td className={tableTdClass}>{job.lastRun}</td>
                <td className="px-4 py-3.5 whitespace-nowrap"><StatusBadge active={!job.suspended} backingUp={job.backingUp} label={job.backingUp ? 'Backing up' : job.suspended ? 'Suspended' : 'Active'} /></td>
                <td className={tableTdActionClass}>
                  <div className={tableActionGroupClass}>
                    <button onClick={() => action(api(`/api/schedules/${job.namespace}/${job.name}/run`, { method: 'POST' }), 'Manual Job created.')} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all" title="Run Now"><Play className="w-4 h-4" /></button>
                    <button onClick={() => setEditing(job)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all" title="Edit Schedule"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => action(api(`/api/schedules/${job.namespace}/${job.name}`, { method: 'PATCH', body: JSON.stringify({ suspended: !job.suspended }) }), job.suspended ? 'Schedule resumed.' : 'Schedule suspended.')} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all" title={job.suspended ? 'Resume schedule' : 'Pause schedule'}>{job.suspended ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}</button>
                    <button onClick={() => action(api(`/api/schedules/${job.namespace}/${job.name}`, { method: 'DELETE' }), 'Schedule deleted.')} className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Delete"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {(schedules.length === 0 || loading) && <EmptyRow colSpan={6} icon={<Clock />} text={loading ? 'Loading schedules...' : 'No schedules found.'} />}
          </tbody>
        </table>
        </div>
      </div>
      {newOpen && <ScheduleModal pvcs={pvcs} initialSelected={[]} defaultSchedule={settings.defaultSchedule} onClose={() => setNewOpen(false)} onDone={() => { setNewOpen(false); refresh(); notify('Schedule created.'); }} notify={notify} />}
      {editing && <EditScheduleModal schedules={Array.isArray(editing) ? editing : [editing]} onClose={() => setEditing(null)} onDone={() => { setEditing(null); setSelected([]); refresh(); notify(Array.isArray(editing) ? 'Schedules updated.' : 'Schedule updated.'); }} notify={notify} />}
    </div>
  );
}
