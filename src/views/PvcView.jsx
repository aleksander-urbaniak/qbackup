import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Eye, HardDrive, Play, RefreshCw, Search } from 'lucide-react';
import { api } from '../lib/api';
import { tableActionGroupClass, tableBodyClass, tableClass, tableHeadClass, tableHeadRowClass, tableShellClass, tableTdActionClass, tableTdClass, tableThActionClass, tableThClass, tableRowClass } from '../lib/tableClasses';
import { CustomCheckbox, EmptyRow, InspectModal } from '../components/shared';
import { ScheduleModal } from '../components/ScheduleModal';

export default function PvcView({ settings, notify, startJobStream }) {
  const [pvcs, setPvcs] = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [inspect, setInspect] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPvcs(await api('/api/pvcs'));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { refresh(); }, [refresh]);

  const filteredPvcs = useMemo(() => pvcs.filter((pvc) => `${pvc.namespace}/${pvc.name}/${pvc.sc}/${pvc.phase}`.toLowerCase().includes(search.toLowerCase())), [pvcs, search]);
  const selectedPvcs = pvcs.filter((pvc) => selected.includes(pvc.id));
  const selectablePvcs = filteredPvcs.filter((pvc) => !pvc.qbackupInternal);
  const allVisibleSelected = selectablePvcs.length > 0 && selectablePvcs.every((pvc) => selected.includes(pvc.id));

  const toggleSelect = (id) => {
    const pvc = pvcs.find((item) => item.id === id);
    if (pvc?.qbackupInternal) return;
    setSelected((prev) => prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]);
  };
  const toggleAll = () => setSelected((prev) => allVisibleSelected ? prev.filter((id) => !selectablePvcs.some((pvc) => pvc.id === id)) : [...new Set([...prev, ...selectablePvcs.map((pvc) => pvc.id)])]);

  const handleBackup = async (pvcIds) => {
    const targetIds = pvcIds ?? selected;
    try {
      const job = await api('/api/backups', { method: 'POST', body: JSON.stringify({ pvcs: targetIds }) });
      startJobStream(job);
      notify('Backup job started.');
      if (!pvcIds) setSelected([]);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  return (
    <div className="flex flex-col h-full max-w-[1400px] w-full mx-auto">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-end gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Persistent Volume Claims</h1>
          <p className="text-slate-500 text-sm mt-1">Select PVCs to create on-demand backups or schedule them.</p>
        </div>
        <div className="flex gap-3">
          <div className="relative">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" placeholder="Filter PVCs..." className="pl-10 pr-4 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-64 shadow-sm" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <button onClick={refresh} className="px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm hover:bg-slate-50" title="Refresh PVCs">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className={`${tableShellClass} flex-1 flex flex-col`}>
        <div className={`min-h-[58px] border-b px-6 py-3 flex items-center justify-between transition-colors ${selected.length > 0 ? 'bg-blue-500/10 border-blue-500/20' : 'bg-slate-900/30 border-slate-800/80'}`}>
          <span className={`text-sm font-medium transition-colors ${selected.length > 0 ? 'text-blue-300' : 'text-slate-500'}`}>
            {selected.length > 0 ? `${selected.length} PVC(s) selected` : 'Select PVCs for bulk actions'}
          </span>
          <div className={`flex gap-2 transition-opacity ${selected.length > 0 ? 'opacity-100' : 'opacity-40'}`}>
              <button disabled={selected.length === 0} onClick={() => handleBackup()} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-md border border-slate-700 transition-colors flex items-center gap-2 disabled:cursor-not-allowed disabled:hover:bg-slate-800">
                <Play className="w-3.5 h-3.5" />
                Backup Selected
              </button>
              <button disabled={selected.length === 0} onClick={() => setScheduleOpen(true)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-md border border-slate-700 transition-colors flex items-center gap-2 disabled:cursor-not-allowed disabled:hover:bg-slate-800">
                <Clock className="w-3.5 h-3.5" />
                Schedule
              </button>
          </div>
        </div>
        <div className="overflow-auto">
          <table className={tableClass}>
            <thead className={tableHeadClass}>
              <tr className={tableHeadRowClass}>
                <th className="px-6 py-4 w-12">
                  <CustomCheckbox checked={allVisibleSelected} indeterminate={selected.length > 0 && !allVisibleSelected} onChange={toggleAll} ariaLabel="Select all PVCs" />
                </th>
                <th className={tableThClass}>Namespace</th>
                <th className={tableThClass}>Name</th>
                <th className={tableThClass}>Phase</th>
                <th className={tableThClass}>Size</th>
                <th className={tableThClass}>Storage Class</th>
                <th className={tableThActionClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={tableBodyClass}>
            {filteredPvcs.map((pvc) => (
              <tr key={pvc.id} className={`${tableRowClass} ${selected.includes(pvc.id) ? 'bg-blue-500/5 hover:bg-blue-500/10' : ''}`}>
                <td className="px-6 py-3.5 whitespace-nowrap">
                  <CustomCheckbox checked={selected.includes(pvc.id)} disabled={pvc.qbackupInternal} onChange={() => toggleSelect(pvc.id)} ariaLabel={`Select ${pvc.namespace}/${pvc.name}`} />
                </td>
                <td className={`${tableTdClass} font-mono`}>{pvc.namespace}</td>
                <td className="px-4 py-3.5 whitespace-nowrap">
                  <span className="text-sm font-medium text-slate-100 group-hover:text-white transition-colors">{pvc.name}</span>
                  {pvc.qbackupInternal && <span className="ml-2 align-middle text-[11px] font-medium text-blue-300 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">qbackup data</span>}
                </td>
                <td className="px-4 py-3.5 whitespace-nowrap">
                  <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ring-1 ring-inset ${pvc.phase === 'Bound' ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20' : 'bg-amber-500/10 text-amber-300 ring-amber-500/20'}`}>
                    {pvc.phase === 'Bound' && <CheckCircle2 className="w-3.5 h-3.5" />}
                    {pvc.phase}
                  </div>
                </td>
                <td className={`${tableTdClass} text-slate-300 font-mono`}>{pvc.size}</td>
                <td className={tableTdClass}>{pvc.sc}</td>
                <td className={tableTdActionClass}>
                  <div className={tableActionGroupClass}>
                    <button onClick={() => handleBackup([pvc.id])} disabled={pvc.phase !== 'Bound' || pvc.qbackupInternal} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed" title={pvc.qbackupInternal ? 'qbackup data PVC' : 'Backup Now'}><Play className="w-4 h-4" /></button>
                    <button onClick={() => setInspect(pvc)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors" title="Inspect">
                      <Eye className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {(filteredPvcs.length === 0 || loading) && <EmptyRow colSpan={7} icon={<HardDrive />} text={loading ? 'Loading PVCs...' : 'No PVCs found.'} />}
          </tbody>
        </table>
        </div>
      </div>

      {inspect && <InspectModal pvc={inspect} onClose={() => setInspect(null)} />}
      {scheduleOpen && <ScheduleModal pvcs={selectedPvcs} initialSelected={selectedPvcs.map((pvc) => pvc.id)} defaultSchedule={settings.defaultSchedule} onClose={() => setScheduleOpen(false)} onDone={() => { setScheduleOpen(false); notify('Schedule created.'); }} notify={notify} />}
    </div>
  );
}
