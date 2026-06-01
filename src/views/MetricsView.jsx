import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, HeartPulse, PauseCircle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

function MetricCard({ label, value, tone = 'slate' }) {
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-red-300' : 'text-slate-100';
  return (
    <div className="rounded-lg border border-slate-800/80 bg-[#05080f] p-4">
      <div className="text-xs font-medium uppercase text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function StatusLine({ ok, label, detail, muted = false }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-800/80 bg-[#05080f] p-4">
      {muted ? <PauseCircle className="mt-0.5 h-5 w-5 text-slate-500" /> : ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /> : <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-400" />}
      <div className="min-w-0">
        <div className="font-medium text-slate-100">{label}</div>
        <div className="mt-1 break-words text-sm text-slate-400">{detail || 'No errors reported.'}</div>
      </div>
    </div>
  );
}

export default function MetricsView({ notify }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setSnapshot(await api('/api/metrics'));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const summary = useMemo(() => {
    const pods = snapshot?.cluster?.pods || [];
    const jobs = snapshot?.cluster?.jobs || [];
    return {
      failedPods: pods.filter((pod) => pod.phase === 'Failed').length,
      runningPods: pods.filter((pod) => pod.phase === 'Running' || pod.phase === 'Pending').length,
      failedJobs: jobs.filter((job) => job.status === 'failed').length,
      activeJobs: jobs.filter((job) => job.status === 'active').length,
      schedules: snapshot?.cluster?.schedules?.length || 0
    };
  }, [snapshot]);
  const autoHealEnabled = Boolean(snapshot?.config?.autoHealEnabled);

  if (loading && !snapshot) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading metrics...</div>;
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] pb-12">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Metrics</h1>
          <p className="mt-1 text-sm text-slate-500">Live qbackup health, Kubernetes backup state, and auto-heal status.</p>
        </div>
        <a href="/metrics" className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">
          <HeartPulse className="h-4 w-4" />
          Prometheus scrape
        </a>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Running Pods" value={summary.runningPods} tone="good" />
        <MetricCard label="Failed Pods" value={summary.failedPods} tone={summary.failedPods ? 'bad' : 'good'} />
        <MetricCard label="Active Jobs" value={summary.activeJobs} />
        <MetricCard label="Failed Jobs" value={summary.failedJobs} tone={summary.failedJobs ? 'bad' : 'good'} />
        <MetricCard label="Schedules" value={summary.schedules} />
        <MetricCard label="Auto-Heal Retries" value={snapshot?.config?.autoHealRetries ?? '0'} tone={snapshot?.config?.autoHealEnabled ? 'good' : 'warn'} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <StatusLine ok={snapshot?.cluster?.lastSuccess} label="Kubernetes scrape" detail={snapshot?.cluster?.lastError || `Last scrape: ${snapshot?.cluster?.lastScrapeAt || 'never'}`} />
        <StatusLine
          muted={!autoHealEnabled}
          ok={autoHealEnabled && snapshot?.autoHeal?.lastSuccess}
          label={autoHealEnabled ? 'Auto-heal monitor' : 'Auto-heal disabled'}
          detail={autoHealEnabled ? snapshot?.autoHeal?.lastError || `Last run: ${snapshot?.autoHeal?.lastRunAt || 'never'}` : 'Enable backup auto-heal in Settings to recreate failed qbackup Pods and Jobs.'}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-slate-800/80 bg-[#0B101A]">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-200">Backup Pods</h2>
            <button onClick={load} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh metrics">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-[#0B101A] text-xs uppercase text-slate-500">
                <tr><th className="px-5 py-3">Pod</th><th className="px-5 py-3">Phase</th><th className="px-5 py-3">Retries</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {(snapshot?.cluster?.pods || []).map((pod) => (
                  <tr key={`${pod.namespace}/${pod.name}`} className="text-slate-300">
                    <td className="px-5 py-3 font-mono text-xs">{pod.namespace}/{pod.name}<div className="mt-1 text-slate-500">{pod.component} {pod.pvc}</div></td>
                    <td className="px-5 py-3">{pod.phase}</td>
                    <td className="px-5 py-3">{pod.retries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-slate-800/80 bg-[#0B101A]">
          <div className="border-b border-slate-800/80 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-200">Backup Jobs</h2>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-[#0B101A] text-xs uppercase text-slate-500">
                <tr><th className="px-5 py-3">Job</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Retries</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {(snapshot?.cluster?.jobs || []).map((job) => (
                  <tr key={`${job.namespace}/${job.name}`} className="text-slate-300">
                    <td className="px-5 py-3 font-mono text-xs">{job.namespace}/{job.name}<div className="mt-1 text-slate-500">{job.pvc}</div></td>
                    <td className="px-5 py-3">{job.status}</td>
                    <td className="px-5 py-3">{job.retries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
