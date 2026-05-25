import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, File, FilePlus, Folder, FolderPlus, HardDrive, Pencil, RefreshCw, Save, ShieldAlert, Trash2, X } from 'lucide-react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import { api, apiBlob } from '../lib/api';
import { StyledSelect } from '../components/shared';

globalThis.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  }
};

loader.config({ monaco });

export default function LiveFilesView({ notify }) {
  const [pvcs, setPvcs] = useState([]);
  const [pvc, setPvc] = useState('');
  const [entriesByPath, setEntriesByPath] = useState({});
  const [expanded, setExpanded] = useState(new Set(['.']));
  const [loading, setLoading] = useState(false);
  const [loadingPath, setLoadingPath] = useState('');
  const [openFile, setOpenFile] = useState('');
  const [downloadOnlyEntry, setDownloadOnlyEntry] = useState(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const dirty = content !== originalContent;
  const changeSummary = useMemo(() => contentChangeSummary(originalContent, content), [content, originalContent]);
  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    cursorBlinking: 'smooth',
    fontFamily: '"Cascadia Mono", "Fira Code", Consolas, monospace',
    fontLigatures: false,
    fontSize: 13,
    folding: true,
    foldingHighlight: true,
    foldingImportsByDefault: false,
    foldingStrategy: 'indentation',
    glyphMargin: false,
    guides: {
      indentation: true,
      highlightActiveIndentation: true
    },
    lineDecorationsWidth: 12,
    lineHeight: 20,
    lineNumbers: 'on',
    lineNumbersMinChars: 3,
    minimap: { enabled: false },
    overviewRulerBorder: false,
    padding: { top: 16, bottom: 16 },
    renderLineHighlight: 'line',
    renderWhitespace: 'boundary',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: 12,
      horizontalScrollbarSize: 12
    },
    showFoldingControls: 'always',
    tabSize: 2,
    wordWrap: 'off'
  }), []);

  useEffect(() => {
    api('/api/pvcs').then(setPvcs).catch((error) => notify(error.message, 'error'));
  }, [notify]);

  const rows = useMemo(() => visibleTreeRows(entriesByPath, expanded), [entriesByPath, expanded]);

  const loadDirectory = async (nextPath = '.', nextPvc = pvc) => {
    if (!nextPvc) return notify('Select a PVC first.', 'error');
    setLoading(true);
    setLoadingPath(nextPath);
    try {
      const data = await api('/api/live-files/list', { method: 'POST', body: JSON.stringify({ pvc: nextPvc, path: nextPath }) });
      setEntriesByPath((current) => ({ ...current, [data.path]: data.entries || [] }));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
      setLoadingPath('');
    }
  };

  const toggleDirectory = async (entry) => {
    setSelectedEntry(entry);
    if (!expanded.has(entry.path) && !entriesByPath[entry.path]) {
      await loadDirectory(entry.path);
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const refreshTree = async () => {
    if (!pvc) return;
    setEntriesByPath({});
    setExpanded(new Set(['.']));
    setSelectedEntry(null);
    await loadDirectory('.');
  };

  const openTextFile = async (entry) => {
    const downloadOnlyReason = downloadOnlyReasonForEntry(entry);
    if (downloadOnlyReason) return openDownloadOnlyFile(entry, downloadOnlyReason);
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSelectedEntry(entry);
    setDownloadOnlyEntry(null);
    setLoading(true);
    try {
      const data = await api('/api/live-files/read', { method: 'POST', body: JSON.stringify({ pvc, path: entry.path }) });
      setOpenFile(data.path);
      setContent(data.content || '');
      setOriginalContent(data.content || '');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const openDownloadOnlyFile = (entry, reason = downloadOnlyReasonForEntry(entry)) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSelectedEntry(entry);
    setDownloadOnlyEntry({ ...entry, reason });
    setOpenFile('');
    setContent('');
    setOriginalContent('');
    notify(`${entry.name} is download-only. ${reason}`, 'info', 'Download only');
  };

  const reloadOpenFile = async () => {
    if (!openFile) return;
    if (dirty && !window.confirm('Discard unsaved changes and reload from PVC?')) return;
    setLoading(true);
    try {
      const data = await api('/api/live-files/read', { method: 'POST', body: JSON.stringify({ pvc, path: openFile }) });
      setContent(data.content || '');
      setOriginalContent(data.content || '');
      notify(`Reloaded ${openFile}.`, 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const discardChanges = () => {
    if (!openFile || !dirty) return;
    if (!window.confirm(`Discard unsaved changes to ${openFile}?`)) return;
    setContent(originalContent);
  };

  const saveFile = async () => {
    if (!openFile || !dirty) return;
    setDialog({ kind: 'save', title: 'Save File' });
  };

  const submitSaveFile = async () => {
    setSaving(true);
    try {
      await api('/api/live-files/write', { method: 'POST', body: JSON.stringify({ pvc, path: openFile, content }) });
      setOriginalContent(content);
      notify(`Saved ${openFile}.`, 'success');
      setDialog(null);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const choosePvc = (event) => {
    const nextPvc = event.target.value;
    setPvc(nextPvc);
    setEntriesByPath({});
    setExpanded(new Set(['.']));
    setOpenFile('');
    setDownloadOnlyEntry(null);
    setSelectedEntry(null);
    setContent('');
    setOriginalContent('');
    if (nextPvc) loadDirectory('.', nextPvc);
  };

  const actionParentPath = selectedEntry?.type === 'directory' ? selectedEntry.path : parentPath(selectedEntry?.path || '.');

  const createEntry = async (type) => {
    if (!pvc) return notify('Select a PVC first.', 'error');
    setDialog({ kind: 'create', type, title: type === 'file' ? 'New File' : 'New Folder', value: '' });
  };

  const submitCreateEntry = async (type, name) => {
    if (!name) return;
    try {
      const route = type === 'file' ? '/api/live-files/create-file' : '/api/live-files/create-folder';
      await api(route, { method: 'POST', body: JSON.stringify({ pvc, parentPath: actionParentPath, name }) });
      await refreshTree();
      notify(`${type === 'file' ? 'File' : 'Folder'} created.`, 'success');
      setDialog(null);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const renameEntry = async () => {
    if (!selectedEntry) return notify('Select a file or folder first.', 'error');
    setDialog({ kind: 'rename', title: 'Rename Item', value: selectedEntry.name });
  };

  const submitRenameEntry = async (name) => {
    if (!name || name === selectedEntry.name) return;
    try {
      const data = await api('/api/live-files/rename', { method: 'POST', body: JSON.stringify({ pvc, path: selectedEntry.path, name }) });
      if (openFile === selectedEntry.path) setOpenFile(data.path);
      if (downloadOnlyEntry?.path === selectedEntry.path) setDownloadOnlyEntry((current) => current ? { ...current, path: data.path, name } : current);
      setSelectedEntry(null);
      setEntriesByPath({});
      setExpanded(new Set(['.']));
      await refreshTree();
      notify('Renamed item.', 'success');
      setDialog(null);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const deleteEntry = async () => {
    if (!selectedEntry) return notify('Select a file or folder first.', 'error');
    setDialog({ kind: 'delete', title: 'Delete Item' });
  };

  const downloadEntry = async () => {
    if (!pvc) return notify('Select a PVC first.', 'error');
    const targetPath = selectedEntry?.path || '.';
    setDownloading(true);
    try {
      const { blob, filename } = await apiBlob('/api/live-files/download', {
        method: 'POST',
        body: JSON.stringify({ pvc, path: targetPath })
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || 'live-files.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify('Download is ready.', 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setDownloading(false);
    }
  };

  const submitDeleteEntry = async () => {
    try {
      await api('/api/live-files/delete', { method: 'POST', body: JSON.stringify({ pvc, path: selectedEntry.path }) });
      if (openFile === selectedEntry.path) {
        setOpenFile('');
        setContent('');
        setOriginalContent('');
      }
      if (downloadOnlyEntry?.path === selectedEntry.path) setDownloadOnlyEntry(null);
      setSelectedEntry(null);
      setEntriesByPath({});
      setExpanded(new Set(['.']));
      await refreshTree();
      notify('Deleted item.', 'success');
      setDialog(null);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-[720px] w-full max-w-[1600px] flex-col">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-semibold text-white">Live File Explorer</h1>
          <p className="text-sm text-slate-400">Browse and edit files directly inside a selected PVC.</p>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div>Changes are written to the live PVC. qbackup records file reads and writes in the audit log.</div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[440px_minmax(0,1fr)]">
        <section className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-slate-800/80 bg-[#0B101A]">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-300">
              <HardDrive className="h-4 w-4 shrink-0 text-slate-500" />
              <StyledSelect
                value={pvc}
                onChange={choosePvc}
                className="min-w-0 flex-1"
                options={[['', 'Select a PVC...'], ...pvcs.map((item) => [item.id, `${item.namespace} / ${item.name}`])]}
              />
            </div>
            <button
              type="button"
              disabled={!pvc || loading}
              onClick={refreshTree}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1 border-b border-slate-800/80 bg-[#05080f] px-4 py-2 text-xs">
            <button
              type="button"
              onClick={() => {
                setExpanded(new Set(['.']));
                setSelectedEntry(null);
              }}
              className="rounded border border-slate-700 px-2 py-1 font-mono text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              /
            </button>
            <div className="ml-auto flex items-center gap-1">
              <ToolButton icon={<FilePlus />} label="New file" disabled={!pvc || loading} onClick={() => createEntry('file')} />
              <ToolButton icon={<FolderPlus />} label="New folder" disabled={!pvc || loading} onClick={() => createEntry('folder')} />
              <ToolButton icon={<Pencil />} label="Rename" disabled={!selectedEntry || loading} onClick={renameEntry} />
              <ToolButton icon={<Download />} label={selectedEntry ? 'Download selected' : 'Download root'} disabled={!pvc || loading || downloading} onClick={downloadEntry} />
              <ToolButton icon={<Trash2 />} label="Delete" disabled={!selectedEntry || loading} onClick={deleteEntry} tone="danger" />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {rows.map((entry) => {
              const downloadOnlyReason = downloadOnlyReasonForEntry(entry);
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => entry.type === 'directory' ? toggleDirectory(entry) : openTextFile(entry)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_88px_132px] items-center gap-3 border-b border-slate-800/50 px-4 py-2.5 text-left text-sm hover:bg-slate-800/60 ${selectedEntry?.path === entry.path ? 'bg-blue-600/25 text-white' : openFile === entry.path || downloadOnlyEntry?.path === entry.path ? 'bg-blue-600/10 text-white' : 'text-slate-300'}`}
                  title={downloadOnlyReason || entry.path}
                >
                  <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${entry.depth * 18}px` }}>
                    {entry.type === 'directory' ? (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400">
                        {loadingPath === entry.path ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : expanded.has(entry.path) ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    {entry.type === 'directory' ? <Folder className="h-4 w-4 shrink-0 text-amber-300" /> : <File className={`h-4 w-4 shrink-0 ${downloadOnlyReason ? 'text-amber-300' : 'text-slate-400'}`} />}
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="text-xs text-slate-500">{entry.size === '-' ? '-' : formatBytes(entry.size)}</span>
                  <span className="truncate text-xs text-slate-500">{formatModified(entry.modified)}</span>
                </button>
              );
            })}
            {!loading && pvc && rows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">This folder is empty.</div>}
            {!pvc && <div className="p-8 text-center text-sm text-slate-500">Select a PVC to start browsing.</div>}
          </div>
        </section>

        <section className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-slate-800/80 bg-[#0B101A]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate text-sm font-medium text-slate-200">{openFile || downloadOnlyEntry?.path || 'No file open'}</div>
                {dirty && <span className="shrink-0 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200">Modified</span>}
                {downloadOnlyEntry && <span className="shrink-0 rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">Download only</span>}
              </div>
              <div className="text-xs text-slate-500">
                {dirty ? `Unsaved changes - ${changeSummary}` : downloadOnlyEntry ? downloadOnlyEntry.reason : openFile ? 'Saved' : 'Open a text file from the explorer'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {openFile && (
                <>
                  <button
                    type="button"
                    disabled={loading || saving}
                    onClick={reloadOpenFile}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    Reload
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={discardChanges}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X className="h-4 w-4" />
                    Discard
                  </button>
                </>
              )}
              {downloadOnlyEntry && (
                <button
                  type="button"
                  disabled={downloading}
                  onClick={downloadEntry}
                  className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Download className="h-4 w-4" />
                  {downloading ? 'Downloading...' : 'Download'}
                </button>
              )}
              <button
                type="button"
                disabled={!openFile || !dirty || saving}
                onClick={saveFile}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
          <div className="qbackup-live-monaco min-h-0 flex-1 bg-[#05080f]">
            {downloadOnlyEntry ? (
              <div className="flex h-full items-center justify-center p-6 text-center">
                <div className="max-w-md">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/60 text-slate-300">
                    <Download className="h-5 w-5" />
                  </div>
                  <div className="mb-1 text-sm font-medium text-slate-200">{downloadOnlyEntry.name}</div>
                  <div className="mb-5 text-sm leading-6 text-slate-500">{downloadOnlyEntry.reason}</div>
                  <button
                    type="button"
                    disabled={downloading}
                    onClick={downloadEntry}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                  >
                    <Download className="h-4 w-4" />
                    {downloading ? 'Downloading...' : 'Download file'}
                  </button>
                </div>
              </div>
            ) : (
              <Editor
                key={openFile || 'empty'}
                height="100%"
                path={openFile || 'empty.txt'}
                language={languageForPath(openFile)}
                theme="qbackup-dark"
                value={openFile ? content : ''}
                loading={<div className="flex h-full items-center justify-center text-sm text-slate-500">Loading editor...</div>}
                beforeMount={configureMonacoTheme}
                onChange={(value) => setContent(value || '')}
                options={{ ...editorOptions, readOnly: !openFile, domReadOnly: !openFile }}
              />
            )}
          </div>
        </section>
      </div>

      {dialog?.kind === 'create' && (
        <NameDialog
          title={dialog.title}
          label={dialog.type === 'file' ? 'File name' : 'Folder name'}
          value={dialog.value}
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitCreateEntry(dialog.type, value)}
        />
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title={dialog.title}
          label="New name"
          value={dialog.value}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={submitRenameEntry}
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={dialog.title}
          message={`Delete ${selectedEntry?.path}? This cannot be undone.`}
          confirmLabel="Delete"
          onClose={() => setDialog(null)}
          onConfirm={submitDeleteEntry}
        />
      )}

      {dialog?.kind === 'save' && (
        <ConfirmDialog
          title={dialog.title}
          message={`Save changes to ${openFile} on ${pvc}?`}
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onConfirm={submitSaveFile}
        />
      )}
    </div>
  );
}

function NameDialog({ title, label, value, confirmLabel, onClose, onSubmit }) {
  const [draft, setDraft] = useState(value || '');
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(draft.trim());
        }}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700 bg-[#0B101A] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/30 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded-xl border border-slate-700/60 bg-[#05080f] px-4 py-2.5 text-sm text-slate-200 transition-all placeholder:text-slate-600 focus:border-white/50 focus:outline-none focus:ring-1 focus:ring-white/30"
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 bg-slate-900/30 px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-5 py-2.5 text-sm font-medium text-slate-400 transition-all hover:bg-slate-800 hover:text-white">Cancel</button>
          <button disabled={!draft.trim()} className="qbackup-primary-white rounded-xl px-6 py-2.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, onClose, onConfirm }) {
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700 bg-[#0B101A] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/30 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          <p className="break-words text-sm leading-6 text-slate-300">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 bg-slate-900/30 px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-5 py-2.5 text-sm font-medium text-slate-400 transition-all hover:bg-slate-800 hover:text-white">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-xl bg-red-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-500">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ icon, label, disabled, onClick, tone = 'default' }) {
  const enabledClass = tone === 'danger'
    ? 'text-red-300 hover:bg-red-500/10 hover:text-red-200'
    : 'text-slate-300 hover:bg-slate-800 hover:text-white';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:text-slate-700 ${disabled ? '' : enabledClass}`}
      title={label}
    >
      {icon}
    </button>
  );
}

function parentPath(value) {
  if (!value || value === '.') return '.';
  const parts = value.split('/');
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || '-');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = numeric;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatModified(value) {
  if (!value || value === '-') return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

const editorSizeLimit = 1024 * 1024;
const downloadOnlyExtensions = new Set([
  '7z', 'avi', 'avif', 'bin', 'bmp', 'bz2', 'class', 'db', 'dll', 'dmg', 'doc', 'docx', 'eot', 'exe', 'gif', 'gz',
  'ico', 'iso', 'jar', 'jpeg', 'jpg', 'lockb', 'mov', 'mp3', 'mp4', 'otf', 'pdf', 'png', 'ppt', 'pptx', 'pyc', 'rar',
  'sqlite', 'sqlite3', 'so', 'tar', 'tgz', 'tiff', 'ttf', 'wasm', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'xz', 'zip', 'zst'
]);

function downloadOnlyReasonForEntry(entry) {
  if (!entry || entry.type !== 'file') return '';
  const size = Number(entry.size);
  if (Number.isFinite(size) && size > editorSizeLimit) return `Files larger than ${formatBytes(editorSizeLimit)} are download-only.`;
  const extension = fileExtension(entry.path || entry.name);
  if (downloadOnlyExtensions.has(extension)) return `${extension.toUpperCase()} files are download-only to avoid corrupting binary or media content.`;
  return '';
}

function contentChangeSummary(original, next) {
  const originalLines = String(original || '').split('\n');
  const nextLines = String(next || '').split('\n');
  const maxLines = Math.max(originalLines.length, nextLines.length);
  let changedLines = 0;
  for (let index = 0; index < maxLines; index += 1) {
    if ((originalLines[index] ?? '') !== (nextLines[index] ?? '')) changedLines += 1;
  }
  const byteDelta = textBytes(next) - textBytes(original);
  const lineLabel = changedLines === 1 ? '1 line changed' : `${changedLines} lines changed`;
  if (byteDelta === 0) return lineLabel;
  return `${lineLabel}, ${byteDelta > 0 ? '+' : ''}${formatBytes(byteDelta)}`;
}

function textBytes(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function configureMonacoTheme(monacoInstance) {
  monacoInstance.editor.defineTheme('qbackup-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '708090' },
      { token: 'number', foreground: 'F59E0B' },
      { token: 'string', foreground: '7DD3FC' },
      { token: 'keyword', foreground: 'F87171' },
      { token: 'type', foreground: '34D399' }
    ],
    colors: {
      'editor.background': '#05080f',
      'editor.foreground': '#e2e8f0',
      'editor.lineHighlightBackground': '#16213a80',
      'editorLineNumber.foreground': '#7aa2d8',
      'editorLineNumber.activeForeground': '#dbeafe',
      'editorGutter.background': '#05080f',
      'editorIndentGuide.background1': '#334155',
      'editorIndentGuide.activeBackground1': '#94a3b8',
      'editor.foldBackground': '#1e293b80',
      'editor.selectionBackground': '#2563eb66',
      'editorCursor.foreground': '#e5e7eb',
      'scrollbarSlider.background': '#33415588',
      'scrollbarSlider.hoverBackground': '#475569aa',
      'scrollbarSlider.activeBackground': '#64748bcc'
    }
  });
}

function languageForPath(path) {
  const extension = fileExtension(path);
  const languages = {
    css: 'css',
    dockerfile: 'dockerfile',
    env: 'ini',
    html: 'html',
    js: 'javascript',
    json: 'javascript',
    jsx: 'javascript',
    log: 'plaintext',
    md: 'markdown',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    yaml: 'yaml',
    yml: 'yaml'
  };
  if (!path) return 'plaintext';
  if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return languages[extension] || 'plaintext';
}

function fileExtension(path) {
  const name = String(path || '').split('/').pop() || '';
  if (!name.includes('.')) return '';
  return name.split('.').pop()?.toLowerCase() || '';
}

function visibleTreeRows(entriesByPath, expanded) {
  const rows = [];
  const visit = (path, depth) => {
    const entries = entriesByPath[path] || [];
    for (const entry of entries) {
      rows.push({ ...entry, depth });
      if (entry.type === 'directory' && expanded.has(entry.path)) {
        visit(entry.path, depth + 1);
      }
    }
  };
  visit('.', 0);
  return rows;
}
