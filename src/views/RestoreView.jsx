import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, Clock, Database, FileArchive, HardDrive, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { Stepper, StyledSelect } from '../components/shared';

export default function RestoreView({ notify, startJobStream }) {
  const [step, setStep] = useState(1);
  const [pvcs, setPvcs] = useState([]);
  const [target, setTarget] = useState('');
  const [archives, setArchives] = useState([]);
  const [archive, setArchive] = useState('');
  const [loadingArchives, setLoadingArchives] = useState(false);

  const selectedPvc = pvcs.find((pvc) => pvc.id === target);

  useEffect(() => { api('/api/pvcs').then(setPvcs).catch((error) => notify(error.message, 'error')); }, [notify]);

  const loadArchives = async () => {
    if (!target) return notify('Select a target PVC first.', 'error');
    const [namespace, pvc] = target.split('/');
    setLoadingArchives(true);
    try {
      const rows = await api(`/api/archives/${namespace}/${pvc}`);
      setArchives(rows);
      setArchive(rows[0]?.name || '');
      setStep(2);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoadingArchives(false);
    }
  };

  const startRestore = async () => {
    try {
      const job = await api('/api/restore', { method: 'POST', body: JSON.stringify({ pvc: target, archive }) });
      startJobStream(job);
      notify('Restore job started.');
      setStep(1);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  return (
    <div className="max-w-[1400px] w-full mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white mb-1">Restore from Backup</h1>
        <p className="text-sm text-slate-400">Replace the contents of a PVC with a previously created backup archive.</p>
      </div>

      <div className="bg-[#0B101A] border border-slate-800/80 rounded-xl shadow-xl min-h-[560px]">
        <div className="max-w-5xl mx-auto p-6 sm:p-10 min-h-[560px] flex flex-col justify-center">
          <Stepper step={step} />

          {step === 1 && (
            <div>
              <div className="mb-8">
                <h2 className="text-base font-medium text-slate-200 mb-4">Select target PVC</h2>
                <div className="relative">
                  <StyledSelect
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    options={[['', 'Select a PVC to restore into...'], ...pvcs.map((pvc) => [pvc.id, `${pvc.namespace} / ${pvc.name}`])]}
                  />
                </div>
              </div>
              <div className="flex justify-end pt-5 border-t border-slate-800/80">
                <button disabled={!target || loadingArchives} onClick={loadArchives} className={`px-5 py-2.5 text-sm font-medium rounded-lg transition-all flex items-center gap-2 ${target && !loadingArchives ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
                  {loadingArchives ? 'Loading...' : 'Next Step'}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="mb-8">
                <h2 className="text-base font-medium text-slate-200 mb-4">Select Archive</h2>
                <div className="space-y-3">
                  {archives.map((item) => {
                    const details = archiveDetails(item.name, item.size, selectedPvc);
                    return <BackupArchiveItem key={item.name} details={details} selected={archive === item.name} onClick={() => setArchive(item.name)} />;
                  })}
                  {archives.length === 0 && <p className="text-sm text-slate-500">No archives found for this PVC.</p>}
                </div>
              </div>
              <div className="flex justify-between pt-5 border-t border-slate-800/80">
                <button onClick={() => setStep(1)} className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-medium">Back</button>
                <button disabled={!archive} onClick={() => setStep(3)} className={`px-5 py-2.5 text-sm font-medium rounded-lg transition-all ${archive ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>Review & Confirm</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-5 mb-8 text-amber-200">
                <h3 className="font-bold flex items-center gap-2 mb-2"><AlertTriangle className="w-5 h-5" /> Warning: Destructive Action</h3>
                <p className="text-sm">You are about to overwrite the contents of <strong>{target}</strong> with <strong>{archive}</strong>.</p>
              </div>
              <div className="flex justify-between pt-5 border-t border-slate-800/80">
                <button onClick={() => setStep(2)} className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-medium">Back</button>
                <button onClick={startRestore} className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Start Restore Process</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function archiveDetails(name, size, pvc) {
  const timestamp = String(name).match(/^(\d{14})/);
  const takenAt = timestamp ? formatArchiveTimestamp(timestamp[1]) : { date: 'Unknown date', time: 'unknown time' };
  return {
    takenAt,
    pvc: pvc ? `${pvc.namespace}/${pvc.name}` : 'selected PVC',
    size: formatBytes(size),
    archive: name
  };
}

function formatArchiveTimestamp(value) {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(8, 10);
  const minute = value.slice(10, 12);
  const second = value.slice(12, 14);
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  if (Number.isNaN(date.getTime())) return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}:${second}` };
  return { date: date.toLocaleDateString(), time: date.toLocaleTimeString() };
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || 'unknown');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = numeric;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function BackupArchiveItem({ details, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full items-center gap-5 overflow-hidden rounded-lg border p-4 text-left transition-all ${
        selected
          ? 'bg-blue-500/5 border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.05)]'
          : 'bg-[#0A0E17] border-slate-800/80 hover:border-slate-700 hover:bg-[#131A2B]'
      }`}
    >
      {selected && <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg bg-blue-500" />}

      <div className="pl-1 shrink-0">
        <div className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-all duration-200 ${selected ? 'border-blue-500 bg-blue-500/10' : 'border-slate-600 group-hover:border-slate-400'}`}>
          {selected && <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Clock className={`h-4 w-4 ${selected ? 'text-blue-400' : 'text-slate-500'}`} />
          <span className="text-sm font-semibold tracking-wide text-slate-200">
            Taken {details.takenAt.date}, <span className={selected ? 'text-slate-200' : 'font-medium text-slate-400'}>{details.takenAt.time}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
          <div className="flex items-center gap-1.5 text-slate-400">
            <Database className="h-3.5 w-3.5 text-slate-500" />
            <span className="max-w-[240px] truncate" title={details.pvc}>{details.pvc}</span>
          </div>
          <div className="h-1 w-1 shrink-0 rounded-full bg-slate-700" />
          <div className="flex shrink-0 items-center gap-1.5 text-slate-400">
            <HardDrive className="h-3.5 w-3.5 text-slate-500" />
            <span>{details.size}</span>
          </div>
          <div className="h-1 w-1 shrink-0 rounded-full bg-slate-700" />
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-slate-400">
            <FileArchive className="h-3.5 w-3.5 text-slate-500" />
            <span>{details.archive}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
