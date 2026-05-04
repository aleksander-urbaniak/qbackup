import { useState } from 'react';
import { Clock, Pencil, X } from 'lucide-react';
import { api } from '../lib/api';
import { CustomCheckbox } from './shared';

export function ScheduleModal({ pvcs, initialSelected = [], defaultSchedule, onClose, onDone, notify }) {
  const [schedule, setSchedule] = useState(defaultSchedule || '0 2 * * *');
  const [checked, setChecked] = useState(initialSelected);
  const [saving, setSaving] = useState(false);
  const allChecked = pvcs.length > 0 && checked.length === pvcs.length;
  const togglePvc = (id) => setChecked((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  const toggleAllPvcs = () => setChecked(allChecked ? [] : pvcs.map((pvc) => pvc.id));
  const submit = async () => {
    setSaving(true);
    try {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify({ pvcs: checked, schedule }) });
      onDone();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0B101A] border border-slate-800 rounded-2xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/30">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Create Schedule</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[75vh] flex flex-col gap-6">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Cron Schedule</label>
            <input
              type="text"
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
              className="w-full bg-[#05080f] border border-slate-700/60 text-sm rounded-xl px-4 py-3 font-mono text-slate-200 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all shadow-inner"
            />
            <p className="text-xs text-slate-500 mt-2">Format: Minute Hour Day Month Weekday</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-slate-300">Target PVCs</label>
              <button
                onClick={toggleAllPvcs}
                type="button"
                className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors bg-blue-500/10 hover:bg-blue-500/20 px-2 py-1 rounded-md"
              >
                {allChecked ? 'Clear All' : 'Select All'}
              </button>
            </div>
            <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-[#05080f] max-h-[280px] overflow-y-auto shadow-inner">
              {pvcs.map((pvc, index) => (
                <label
                  key={pvc.id}
                  className={`flex items-center gap-3 px-4 py-3.5 cursor-pointer transition-colors ${
                    index !== pvcs.length - 1 ? 'border-b border-slate-800/50' : ''
                  } ${checked.includes(pvc.id) ? 'bg-slate-800/40' : 'hover:bg-slate-800/20'}`}
                >
                  <CustomCheckbox checked={checked.includes(pvc.id)} onChange={() => togglePvc(pvc.id)} ariaLabel={`Select ${pvc.namespace}/${pvc.name}`} />
                  <span className="text-sm font-mono text-slate-300">{pvc.namespace}/{pvc.name}</span>
                </label>
              ))}
              {pvcs.length === 0 && <div className="px-4 py-10 text-center text-sm text-slate-500">No PVCs available.</div>}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-800/80 bg-slate-900/30 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all">Cancel</button>
          <button
            disabled={saving || checked.length === 0}
            onClick={submit}
            className="qbackup-primary-white px-6 py-2.5 text-sm font-medium rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
export function EditScheduleModal({ schedules, onClose, onDone, notify }) {
  const isBulk = schedules.length > 1;
  const first = schedules[0];
  const [cron, setCron] = useState(isBulk ? '' : first.schedule || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await Promise.all(schedules.map((schedule) => api(`/api/schedules/${schedule.namespace}/${schedule.name}`, {
          method: 'PATCH',
          body: JSON.stringify({ schedule: cron })
        })));
      onDone();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0B101A] border border-slate-800 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/30">
          <div className="flex items-center gap-2">
            <Pencil className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">{isBulk ? 'Bulk Edit Schedules' : 'Edit Schedule'}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-6">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{isBulk ? 'Selected Schedules' : 'Target PVC'}</label>
            <div className="w-full bg-[#05080f] border border-slate-800/80 text-sm rounded-xl px-4 py-3 font-mono text-slate-400 max-h-40 overflow-auto">
              {isBulk ? schedules.map((schedule) => <div key={schedule.id}>{schedule.namespace}/{schedule.pvc}</div>) : `${first.namespace}/${first.pvc}`}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Cron Schedule</label>
            <input
              type="text"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              className="w-full bg-[#05080f] border border-slate-700/60 text-sm rounded-xl px-4 py-3 font-mono text-slate-200 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all shadow-inner"
            />
            <p className="text-xs text-slate-500 mt-2">Format: Minute Hour Day Month Weekday</p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-800/80 bg-slate-900/30 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all">Cancel</button>
          <button
            disabled={saving || !cron.trim()}
            onClick={submit}
            className="qbackup-primary-white px-6 py-2.5 text-sm font-medium rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
