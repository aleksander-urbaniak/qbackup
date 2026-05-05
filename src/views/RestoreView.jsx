import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Clock, Database, Download, File, FileArchive, Folder, HardDrive, RotateCcw, X } from 'lucide-react';
import { api, apiBlob } from '../lib/api';
import { Stepper, StyledSelect } from '../components/shared';

export default function RestoreView({ notify, startJobStream }) {
  const [step, setStep] = useState(1);
  const [restoreMode, setRestoreMode] = useState('pvc');
  const [pvcs, setPvcs] = useState([]);
  const [target, setTarget] = useState('');
  const [archives, setArchives] = useState([]);
  const [archive, setArchive] = useState('');
  const [fileEntries, setFileEntries] = useState([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState('.');
  const [loadingArchives, setLoadingArchives] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [downloading, setDownloading] = useState(false);

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

  const downloadFileRestore = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await apiBlob('/api/file-restore/download', {
        method: 'POST',
        body: JSON.stringify({ pvc: target, archive, path: selectedPath })
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || 'file-restore.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify('File restore zip is ready.');
      setBrowserOpen(false);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setDownloading(false);
    }
  };

  const openFileBrowser = async () => {
    setLoadingCatalog(true);
    try {
      const data = await api('/api/file-restore/catalog', {
        method: 'POST',
        body: JSON.stringify({ pvc: target, archive })
      });
      setFileEntries(data.entries || []);
      setSelectedPath('.');
      setBrowserOpen(true);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoadingCatalog(false);
    }
  };

  return (
    <div className="max-w-[1400px] w-full mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white mb-1">Restore from Backup</h1>
        <p className="text-sm text-slate-400">Restore a PVC or download a selected file path from a backup archive.</p>
      </div>

      <div className="bg-[#0B101A] border border-slate-800/80 rounded-xl shadow-xl min-h-[560px]">
        <div className="max-w-5xl mx-auto p-6 sm:p-10 min-h-[560px] flex flex-col justify-center">
          <Stepper step={step} />

          {step === 1 && (
            <div>
              <div className="mb-8">
                <h2 className="text-base font-medium text-slate-200 mb-4">Select restore option</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <RestoreModeCard
                    icon={<RotateCcw />}
                    title="PVC restore"
                    description="Replace a PVC with a full archive."
                    selected={restoreMode === 'pvc'}
                    onClick={() => setRestoreMode('pvc')}
                  />
                  <RestoreModeCard
                    icon={<Download />}
                    title="File restore"
                    description="Download a selected path as a zip."
                    selected={restoreMode === 'file'}
                    onClick={() => setRestoreMode('file')}
                  />
                </div>
              </div>
              <div className="mb-8">
                <h2 className="text-base font-medium text-slate-200 mb-4">{restoreMode === 'file' ? 'Select source PVC' : 'Select target PVC'}</h2>
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
                <button disabled={!archive || loadingCatalog} onClick={restoreMode === 'file' ? openFileBrowser : () => setStep(3)} className={`px-5 py-2.5 text-sm font-medium rounded-lg transition-all ${archive && !loadingCatalog ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>{loadingCatalog ? 'Loading...' : restoreMode === 'file' ? 'Browse Files' : 'Review & Confirm'}</button>
              </div>
            </div>
          )}

          {step === 3 && restoreMode === 'pvc' && (
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

      {browserOpen && (
        <FileRestoreBrowser
          archive={archive}
          entries={fileEntries}
          selectedPath={selectedPath}
          downloading={downloading}
          onClose={() => setBrowserOpen(false)}
          onDownload={downloadFileRestore}
          onSelect={setSelectedPath}
        />
      )}
    </div>
  );
}

function RestoreModeCard({ icon, title, description, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-start gap-4 rounded-lg border p-4 text-left transition-all ${
        selected
          ? 'bg-blue-500/5 border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.05)]'
          : 'bg-[#0A0E17] border-slate-800/80 hover:border-slate-700 hover:bg-[#131A2B]'
      }`}
    >
      <div className={`mt-0.5 rounded-md p-2 ${selected ? 'bg-blue-500/10 text-blue-300' : 'bg-slate-900 text-slate-500'}`}>
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold text-slate-200">{title}</div>
        <div className="mt-1 text-xs text-slate-500">{description}</div>
      </div>
    </button>
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

function FileRestoreBrowser({ archive, entries, selectedPath, downloading, onClose, onDownload, onSelect }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [expanded, setExpanded] = useState(() => new Set(['.']));
  const rows = useMemo(() => visibleTreeRows(tree, expanded), [tree, expanded]);
  const selectedLabel = selectedPath === '.' ? '/' : `/${selectedPath}`;

  const toggle = (path) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="flex h-[min(720px,calc(100vh-2rem))] w-[min(980px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-slate-700 bg-[#111722] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 bg-[#0B101A] px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-slate-100">File Restore - {archive}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-slate-800 bg-[#0A0E17] px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onSelect('.');
              setExpanded(new Set(['.']));
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${selectedPath === '.' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            /
          </button>
          <span className="min-w-0 truncate font-mono text-xs text-slate-400">{selectedLabel}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[#1B1F26]">
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-[#182231] text-left text-xs font-semibold text-slate-300">
              <tr>
                <th className="w-[52%] px-3 py-2">Name</th>
                <th className="w-[16%] px-3 py-2">Size</th>
                <th className="w-[16%] px-3 py-2">Modified</th>
                <th className="w-[16%] px-3 py-2">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selected = selectedPath === row.path;
                const isDirectory = row.type === 'directory';
                return (
                  <tr
                    key={row.path}
                    onClick={() => onSelect(row.path)}
                    onDoubleClick={() => isDirectory && toggle(row.path)}
                    className={`cursor-default border-b border-slate-800/50 text-slate-100 ${selected ? 'bg-blue-600/40' : 'hover:bg-slate-700/50'}`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${row.depth * 20}px` }}>
                        {isDirectory ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect(row.path);
                              toggle(row.path);
                            }}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-white"
                            title={expanded.has(row.path) ? 'Collapse folder' : 'Expand folder'}
                          >
                            {expanded.has(row.path) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <span className="h-4 w-4 shrink-0" />
                        )}
                        {isDirectory ? <Folder className="h-4 w-4 shrink-0 text-amber-300" /> : <File className="h-4 w-4 shrink-0 text-slate-300" />}
                        <span className="truncate">{row.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{row.size}</td>
                    <td className="px-3 py-2 text-slate-300">{row.modified}</td>
                    <td className="px-3 py-2 text-slate-200">{isDirectory ? 'Directory' : 'File'}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">No files found in this folder.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-slate-700 bg-[#0B101A] px-4 py-3">
          <div className="min-w-0 truncate text-xs text-slate-300">Selected <span className="font-mono text-slate-100">"{selectedLabel}"</span></div>
          <button
            type="button"
            disabled={downloading}
            onClick={onDownload}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${downloading ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Preparing...' : 'Download as zip'}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildTree(entries) {
  const root = { path: '.', name: '/', type: 'directory', size: '-', modified: '-', children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const isLeaf = index === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          path,
          name: part,
          type: isLeaf ? entry.type : 'directory',
          size: isLeaf && entry.type !== 'directory' ? entry.size : '-',
          modified: isLeaf ? entry.modified || '-' : '-',
          children: new Map()
        });
      }
      const child = node.children.get(part);
      if (isLeaf) {
        child.type = entry.type;
        child.size = entry.type === 'directory' ? '-' : formatBytes(entry.size);
        child.modified = entry.modified || '-';
      }
      node = child;
    });
  }
  return root;
}

function visibleTreeRows(root, expanded) {
  const rows = [];
  const visit = (node, depth) => {
    const children = [...node.children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      rows.push({ ...child, depth });
      if (child.type === 'directory' && expanded.has(child.path)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  return rows;
}
