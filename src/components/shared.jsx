import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, Check, CheckCircle, CheckCircle2, ChevronDown, HardDrive, Minus, Moon, ShieldCheck, Sun, Terminal, X } from 'lucide-react';

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
  const ref = useRef(null);
  const selected = options.find(([id]) => id === value) || options[0];

  useEffect(() => {
    const close = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

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
      {open && (
        <div className="qbackup-select-menu" role="listbox">
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
        </div>
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
export function NotificationBell({ notifications, open, setOpen, markAllRead, clearAll, peek, dismissPeek }) {
  const unread = notifications.filter((item) => !item.read).length;
  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) markAllRead();
        }}
        className="relative p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        title="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center font-bold">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-[22rem] max-w-[calc(100vw-2rem)] qbackup-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <div>
              <div className="font-semibold text-sm">Notifications</div>
              <div className="text-xs text-slate-500">{notifications.length} recent events</div>
            </div>
            <button onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-900">Clear</button>
          </div>
          <div className="max-h-96 overflow-auto">
            {notifications.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No notifications yet.</div>
            ) : notifications.map((item) => (
              <div key={item.id} className="px-4 py-3 border-b border-slate-200 last:border-b-0">
                <div className="flex items-start gap-3">
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0 ${item.tone === 'error' ? 'bg-red-500' : item.tone === 'success' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{item.title}</div>
                    <div className="text-sm text-slate-500 mt-0.5 break-words">{item.message}</div>
                    <div className="text-[11px] text-slate-400 mt-1">{new Date(item.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
export function EmptyRow({ colSpan, icon, text }) {
  return <tr><td colSpan={colSpan} className="px-4 py-12 text-center text-slate-500">{React.cloneElement(icon, { className: 'w-12 h-12 mx-auto text-slate-300 mb-3' })}<p>{text}</p></td></tr>;
}

export function CustomCheckbox({ checked, indeterminate = false, onChange, ariaLabel }) {
  const handleClick = (event) => {
    event.stopPropagation();
    onChange?.(event);
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel || 'Select row'}
      onClick={handleClick}
      className={`relative w-[18px] h-[18px] rounded transition-all duration-200 flex items-center justify-center border focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1523] ${
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
