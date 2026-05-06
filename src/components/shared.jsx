import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, Check, CheckCircle, CheckCircle2, ChevronDown, HardDrive, Info, Minus, Moon, ShieldCheck, Sun, Terminal, X, XCircle } from 'lucide-react';

export function FullScreenState({ title, message }) {
  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
      <div className="text-center">
        <ShieldCheck className="w-12 h-12 text-indigo-400 mx-auto mb-4" />
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-slate-400 text-sm mt-2">{message}</p>
      </div>
    </div>
  );
}
export function ThemeToggle({ theme, setTheme }) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
      aria-label="Toggle theme"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <Moon className="theme-icon theme-icon--moon h-5 w-5" /> : <Sun className="theme-icon theme-icon--sun h-5 w-5" />}
    </button>
  );
}
export function DarkField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label>
      <span className="block text-xs font-medium text-slate-400 mb-1.5">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#05080f] border border-slate-700/60 text-sm rounded-xl px-4 py-2.5 text-slate-200 focus:outline-none focus:border-white/50 focus:ring-1 focus:ring-white/30 transition-all placeholder:text-slate-600"
      />
    </label>
  );
}
export function InspectModal({ pvc, onClose }) {
  return <Modal title="PVC Details" icon={<HardDrive />} onClose={onClose}><dl className="grid grid-cols-2 gap-4 text-sm">{Object.entries({ Namespace: pvc.namespace, Name: pvc.name, Phase: pvc.phase, 'Storage Class': pvc.sc, Access: pvc.access, Size: pvc.size, 'Persistent Volume': pvc.pv }).map(([key, value]) => <div key={key}><dt className="text-slate-500">{key}</dt><dd className="font-mono text-slate-900 break-all">{value}</dd></div>)}</dl></Modal>;
}
export function LogPanel({ job }) {
  const output = job?.output?.map((entry) => entry.text).join('') || '';
  return (
    <div className="flex-[3] bg-[#0B101A] border border-slate-800/80 rounded-xl flex flex-col shadow-lg overflow-hidden min-h-[300px]">
      <div className="px-5 py-3.5 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/30">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-slate-400" />
          <h2 className="font-medium text-slate-200 text-sm">{job ? `${job.type} - ${job.status}` : 'No job selected'}</h2>
        </div>
      </div>
      <div className="flex-1 bg-[#05080f] p-5 overflow-auto relative group">
        <pre className="font-mono text-sm text-emerald-500/80 whitespace-pre-wrap">{output || '> Job output will appear here.'}</pre>
      </div>
    </div>
  );
}
export function Modal({ title, icon, onClose, children }) {
  return <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 backdrop-blur-sm p-4"><div className="bg-white rounded-lg shadow-2xl p-6 w-[36rem] max-w-full"><div className="flex justify-between items-center mb-6"><h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">{React.cloneElement(icon, { className: 'w-5 h-5 text-indigo-600' })}{title}</h3><button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X className="w-5 h-5" /></button></div>{children}</div></div>;
}
export function Stepper({ step }) {
  return (
    <div className="flex items-center justify-between mb-10 relative px-2 sm:px-8">
      <div className="absolute left-[10%] right-[10%] top-1/2 -translate-y-1/2 h-px bg-slate-800/80" />
      {[1, 2, 3].map((item) => (
        <div key={item} className="relative z-10 flex flex-col items-center bg-[#0B101A] px-2">
          <div
            className={`w-8 h-8 rounded-full text-sm flex items-center justify-center font-medium ring-4 ring-[#0B101A] ${
              step >= item
                ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                : 'bg-slate-900 border border-slate-700 text-slate-500'
            }`}
          >
            {item}
          </div>
        </div>
      ))}
    </div>
  );
}
export function SettingsPanel({ icon, title, children }) {
  return <section className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden"><div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-2">{React.cloneElement(icon, { className: 'w-5 h-5 text-indigo-600' })}<h2 className="font-semibold text-slate-800">{title}</h2></div><div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">{children}</div></section>;
}
export function TextField({ label, name, value, onChange, type = 'text', mono = false, placeholder = '' }) {
  return <label className="block"><span className="block text-sm font-medium text-slate-700 mb-1">{label}</span><input type={type} name={name} value={value ?? ''} onChange={onChange} placeholder={placeholder} className={`w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm ${mono ? 'font-mono' : ''}`} /></label>;
}
export function SelectField({ label, name, value, onChange, options }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1">{label}</span>
      <StyledSelect name={name} value={value ?? ''} onChange={onChange} options={options} />
    </label>
  );
}

export function StyledSelect({ value, onChange, options, name, className = '', title, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const ref = useRef(null);
  const menuRef = useRef(null);
  const selected = options.find(([id]) => id === value) || options[0];

  useEffect(() => {
    const close = (event) => {
      if (!ref.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const menuHeight = Math.min(256, options.length * 42 + 12);
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow < menuHeight + 12 && rect.top > menuHeight
        ? rect.top - menuHeight - 6
        : rect.bottom + 6;
      setMenuStyle({
        position: 'fixed',
        left: `${Math.min(rect.left, window.innerWidth - 384 - 16)}px`,
        top: `${Math.max(8, top)}px`,
        minWidth: `${rect.width}px`,
        zIndex: 9999
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  const choose = (nextValue, disabledOption) => {
    if (disabled || disabledOption) return;
    onChange?.({ target: { name, value: nextValue } });
    setOpen(false);
  };

  return (
    <span ref={ref} className={`qbackup-select-wrap ${className}`}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((current) => !current)}
        className="qbackup-select"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="block truncate text-left">{selected?.[1] || ''}</span>
      </button>
      <ChevronDown className="qbackup-select-chevron" />
      {open && createPortal(
        <div ref={menuRef} className="qbackup-select-menu" role="listbox" style={menuStyle}>
          {options.map(([id, labelText, disabledOption]) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={id === value}
              disabled={disabledOption}
              onClick={() => choose(id, disabledOption)}
              className={`qbackup-select-option ${id === value ? 'is-selected' : ''}`}
            >
              {labelText}
            </button>
          ))}
        </div>,
        document.body
      )}
    </span>
  );
}
export function StatusBadge({ active, backingUp, label }) {
  if (backingUp) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ring-1 ring-inset bg-blue-500/10 text-blue-300 ring-blue-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        {label}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ring-1 ring-inset ${
      active ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20' : 'bg-amber-500/10 text-amber-300 ring-amber-500/20'
    }`}>
      {active && <CheckCircle2 className="w-3.5 h-3.5" />}
      {label}
    </span>
  );
}
export function StatusPill({ label, ok }) {
  return <span className={`hidden md:inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border ${ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{ok ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}{label}</span>;
}
export function NotificationBell({ notifications, open, setOpen, markAllRead, clearAll, dismissItem, peek, dismissPeek }) {
  const unread = notifications.filter((item) => !item.read).length;
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) markAllRead();
        }}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 ${
          open
            ? 'bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/30'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
        }`}
        title="Notifications"
      >
        <Bell className="w-[18px] h-[18px]" />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-[#0A0E17]" />}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 flex w-[380px] max-w-[calc(100vw-2rem)] origin-top-right flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-[#0f172a] shadow-[0_16px_40px_-15px_rgba(0,0,0,0.5)] animate-[notificationSlideDown_0.2s_ease-out]">
          <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/50 px-5 py-4">
            <div>
              <div className="flex items-center gap-2 font-semibold text-slate-100">
                <span>Notifications</span>
                {unread > 0 && <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-300">{unread} new</span>}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">{notifications.length} recent events</div>
            </div>
            {notifications.length > 0 && (
              <button onClick={clearAll} className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200">Clear all</button>
            )}
          </div>
          <div className="qbackup-notification-scroll max-h-[420px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800/50">
                  <Bell className="h-5 w-5 text-slate-500" />
                </div>
                <p className="text-sm font-medium text-slate-300">No new notifications</p>
                <p className="mt-1 text-xs text-slate-500">You're all caught up.</p>
              </div>
            ) : notifications.map((item) => (
              <div
                key={item.id}
                className={`group relative flex cursor-default items-start gap-4 border-b border-slate-800/40 px-5 py-4 transition-colors last:border-b-0 hover:bg-slate-800/40 ${item.read ? '' : 'bg-slate-800/20'}`}
              >
                {!item.read && <div className="absolute bottom-0 left-0 top-0 w-0.5 bg-indigo-500" />}
                <NotificationToneIcon tone={item.tone} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-start justify-between">
                    <h4 className="truncate pr-4 text-sm font-medium text-slate-200">{item.title}</h4>
                    <span className="mt-1 whitespace-nowrap font-mono text-[10px] tabular-nums text-slate-500">{notificationTime(item.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-line break-words text-xs leading-relaxed text-slate-400">{item.message}</p>
                  <p className="mt-2 font-mono text-[10px] text-slate-600">{notificationDate(item.createdAt)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => dismissItem?.(item.id)}
                  className="absolute right-4 top-4 rounded-md p-1 text-slate-500 opacity-0 transition-opacity hover:text-slate-300 group-hover:opacity-100"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          {notifications.length > 0 && (
            <div className="border-t border-slate-800/80 bg-[#0f172a] px-5 py-3 text-center">
              <span className="text-xs font-medium text-indigo-400">Recent activity</span>
            </div>
          )}
        </div>
      )}
      {peek && !open && (
        <button
          onClick={() => {
            dismissPeek();
            setOpen(true);
            markAllRead();
          }}
          className="absolute right-0 top-12 z-40 w-[20rem] max-w-[calc(100vw-2rem)] qbackup-card p-3 text-left shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <span className={`mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0 ${peek.tone === 'error' ? 'bg-red-500' : peek.tone === 'success' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            <div className="min-w-0">
              <div className="font-semibold text-sm">{peek.title}</div>
              <div className="text-sm text-slate-500 mt-0.5 line-clamp-2">{peek.message}</div>
            </div>
          </div>
        </button>
      )}
    </div>
  );
}

function NotificationToneIcon({ tone }) {
  if (tone === 'success') {
    return <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10"><CheckCircle2 className="h-4 w-4 text-emerald-400" /></div>;
  }
  if (tone === 'error') {
    return <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-rose-500/20 bg-rose-500/10"><XCircle className="h-4 w-4 text-rose-400" /></div>;
  }
  return <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-blue-500/20 bg-blue-500/10"><Info className="h-4 w-4 text-blue-400" /></div>;
}

function notificationTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function notificationDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
export function EmptyRow({ colSpan, icon, text }) {
  return <tr><td colSpan={colSpan} className="px-4 py-12 text-center text-slate-500">{React.cloneElement(icon, { className: 'w-12 h-12 mx-auto text-slate-300 mb-3' })}<p>{text}</p></td></tr>;
}

export function CustomCheckbox({ checked, indeterminate = false, disabled = false, onChange, ariaLabel }) {
  const handleClick = (event) => {
    event.stopPropagation();
    if (disabled) return;
    onChange?.(event);
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      disabled={disabled}
      aria-label={ariaLabel || 'Select row'}
      onClick={handleClick}
      className={`relative w-[18px] h-[18px] rounded transition-all duration-200 flex items-center justify-center border focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1523] ${
        disabled
          ? 'bg-slate-900/50 border-slate-700 text-transparent cursor-not-allowed opacity-50'
          :
        checked || indeterminate
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'bg-[#0A0E17] border-slate-600 hover:border-slate-400 hover:bg-slate-800/50 text-transparent'
      }`}
    >
      {indeterminate ? (
        <Minus className="w-3.5 h-3.5 animate-in zoom-in-50 duration-200" strokeWidth={3} />
      ) : checked ? (
        <Check className="w-3.5 h-3.5 animate-in zoom-in-50 duration-200" strokeWidth={3} />
      ) : null}
    </button>
  );
}

export function NavItem({ icon, label, active, onClick, isOpen }) {
  return (
    <button
      onClick={onClick}
      title={!isOpen ? label : undefined}
      className={`${isOpen ? 'w-full justify-start px-3' : 'w-11 h-11 justify-center px-0'} flex items-center gap-3 py-2.5 rounded-lg border transition-colors overflow-hidden ${
        active ? 'bg-blue-500/10 text-blue-400 border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.05)]' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
      }`}
    >
      <div className="flex-shrink-0">{React.cloneElement(icon, { className: 'w-5 h-5' })}</div>
      {isOpen && <span className="font-medium text-sm whitespace-nowrap truncate">{label}</span>}
    </button>
  );
}
