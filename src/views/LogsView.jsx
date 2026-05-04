import { useEffect, useState } from 'react';
import { Clock, FileText, Shield } from 'lucide-react';
import { api } from '../lib/api';
import { LogPanel } from '../components/shared';

export default function LogsView({ jobs, canReadAudit, notify }) {
  const [active, setActive] = useState(null);
  const [audit, setAudit] = useState([]);
  const [selectedAuditId, setSelectedAuditId] = useState(null);
  const selected = active || jobs[0];

  useEffect(() => {
    if (!canReadAudit) return;
    api('/api/audit').then((data) => setAudit(data.audit || [])).catch((error) => notify(error.message, 'error'));
  }, [canReadAudit, notify]);

  return (
    <div className="max-w-[1400px] w-full mx-auto h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-semibold text-white mb-1">Audit Logs</h1>
        <p className="text-sm text-slate-400">Live output from backup, restore, and archive catalog jobs started in this web session.</p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
        <div className="w-full lg:w-[320px] xl:w-[380px] bg-[#0B101A] border border-slate-800/80 rounded-xl flex flex-col shrink-0 shadow-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800/80 flex items-center gap-2 bg-slate-900/30">
            <FileText className="w-4 h-4 text-slate-400" />
            <h2 className="font-medium text-slate-200 text-sm">Session Jobs</h2>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {jobs.length === 0 ? (
              <div className="h-full flex items-center justify-center p-8">
                <div className="text-center flex flex-col items-center gap-3 opacity-60">
                  <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center border border-slate-700/50">
                    <Clock className="w-5 h-5 text-slate-400" />
                  </div>
                  <p className="text-sm text-slate-400">No jobs started yet.</p>
                </div>
              </div>
            ) : jobs.map((job) => (
              <button key={job.id} onClick={() => setActive(job)} className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${selected?.id === job.id ? 'bg-blue-500/10 border-blue-500/20 shadow-sm' : 'border-transparent hover:bg-slate-800/40 hover:border-slate-700/50'}`}>
                <div className={`font-medium text-sm ${selected?.id === job.id ? 'text-white' : 'text-slate-200'}`}>{job.type}</div>
                <div className="text-xs text-slate-500 font-mono">{job.status} - {new Date(job.startedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-6 min-w-0">
          <LogPanel job={selected} />
          {canReadAudit && (
            <div className="flex-[2] bg-[#0B101A] border border-slate-800/80 rounded-xl flex flex-col shadow-lg overflow-hidden min-h-[250px]">
              <div className="px-5 py-4 border-b border-slate-800/80 flex items-center gap-2 bg-slate-900/30">
                <Shield className="w-4 h-4 text-slate-400" />
                <h2 className="font-medium text-slate-200 text-sm">Security Audit</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {audit.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No audit entries yet.</p>
                ) : (
                  <div className="space-y-1">
                    {audit.map((entry) => (
                      <button key={entry.id} onClick={() => setSelectedAuditId(entry.id)} className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${selectedAuditId === entry.id ? 'bg-blue-500/10 border-blue-500/20 shadow-sm' : 'border-transparent hover:bg-slate-800/40 hover:border-slate-700/50'}`}>
                        <div className="flex flex-col gap-1">
                          <span className={`font-medium text-sm ${selectedAuditId === entry.id ? 'text-white' : 'text-slate-200'}`}>{entry.action}</span>
                          <span className="text-xs text-slate-500 font-mono">{entry.user?.username || 'system'} - {new Date(entry.createdAt).toLocaleString()}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
