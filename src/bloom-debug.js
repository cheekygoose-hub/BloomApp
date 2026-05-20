// ─────────────────────────────────────────────────────────────────────────────
// bloom-debug.js
// Lightweight error capture + compact reporting for Bloom.
//
// TOKEN COST: ~600 tokens (this file alone)
// SHARE THIS FILE WHEN: modifying debug behaviour or report format.
// DO NOT share for normal bug fixes — paste the REPORT TEXT instead.
//
// Usage:
//   import { debug, DebugOverlay } from './bloom-debug.js';
//   debug.catch(fn)          — wrap a call, log any throw
//   debug.log(tag, data)     — manual breadcrumb
//   debug.report()           — returns compact string to paste to Claude
//   <DebugOverlay />         — floating button, tap for report + copy
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_ERRORS   = 20;   // oldest dropped when full
const MAX_CRUMBS   = 30;   // breadcrumb ring buffer
const APP_VERSION  = '0.1.0';

// ─── Store ────────────────────────────────────────────────────────────────────

const store = {
  errors:   [],   // { t, tag, msg, stack }
  crumbs:   [],   // { t, tag, data }
  session:  Date.now(),
};

function ts() { return Math.round((Date.now() - store.session) / 1000) + 's'; }

// ─── Public API ───────────────────────────────────────────────────────────────

export const debug = {

  /** Wrap a synchronous or async call. Logs + rethrows on error. */
  catch(tag, fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') {
        return r.catch(e => { debug._err(tag, e); throw e; });
      }
      return r;
    } catch (e) {
      debug._err(tag, e);
      throw e;
    }
  },

  /** Manual breadcrumb — lightweight, no stack trace. */
  log(tag, data) {
    store.crumbs.push({ t: ts(), tag, data: _trim(data) });
    if (store.crumbs.length > MAX_CRUMBS) store.crumbs.shift();
  },

  /** Clear all captured data. */
  clear() { store.errors = []; store.crumbs = []; store.session = Date.now(); },

  /** Compact plain-text report — paste this to Claude, not the whole file. */
  report() {
    const lines = [
      `BLOOM DEBUG REPORT v${APP_VERSION}`,
      `session: ${ts()} | errors: ${store.errors.length}`,
      '',
    ];
    if (store.errors.length) {
      lines.push('── ERRORS ──');
      store.errors.forEach((e, i) => {
        lines.push(`[${i+1}] +${e.t} ${e.tag}: ${e.msg}`);
        if (e.stack) lines.push('    ' + e.stack.split('\n').slice(1, 4).join(' | ').trim());
      });
      lines.push('');
    }
    if (store.crumbs.length) {
      lines.push('── BREADCRUMBS ──');
      store.crumbs.forEach(c => {
        lines.push(`+${c.t} ${c.tag}${c.data ? ': ' + c.data : ''}`);
      });
    }
    return lines.join('\n');
  },

  // ── Internal ────────────────────────────────────────────────────────────────

  _err(tag, e) {
    const entry = { t: ts(), tag, msg: e?.message || String(e), stack: e?.stack || null };
    store.errors.push(entry);
    if (store.errors.length > MAX_ERRORS) store.errors.shift();
    // eslint-disable-next-line no-console
    console.error(`[bloom:${tag}]`, e);
  },
};

// ─── Global error hooks ───────────────────────────────────────────────────────
// Catches uncaught errors and unhandled promise rejections automatically.

if (typeof window !== 'undefined') {
  window.addEventListener('error', e => {
    debug._err('window', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', e => {
    debug._err('promise', e.reason);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _trim(data) {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data.slice(0, 120);
  try { return JSON.stringify(data).slice(0, 120); } catch { return String(data).slice(0, 120); }
}

function _copy(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const el = document.createElement('textarea');
  el.value = text; document.body.appendChild(el); el.select();
  document.execCommand('copy'); document.body.removeChild(el);
}

// ─── DebugOverlay component ───────────────────────────────────────────────────
// Floating button bottom-left. Tap → report panel with Copy button.
// Invisible in normal use. No token cost until you open it and copy.

export function DebugOverlay() {
  const [open, setOpen]     = useState(false);
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);
  const [count, setCount]   = useState(0);

  // Poll error count every 2s so the badge stays current without re-renders
  useEffect(() => {
    const id = setInterval(() => setCount(store.errors.length), 2000);
    return () => clearInterval(id);
  }, []);

  const openPanel = () => { setReport(debug.report()); setOpen(true); setCopied(false); };

  const copy = () => {
    _copy(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {/* Trigger button — always visible, minimal footprint */}
      <button
        onClick={openPanel}
        style={{
          position: 'fixed', bottom: 72, left: 12, zIndex: 900,
          width: 32, height: 32, borderRadius: '50%',
          background: count > 0 ? 'rgba(196,139,139,0.85)' : 'rgba(180,165,150,0.45)',
          border: 'none', cursor: 'pointer',
          fontSize: 11, color: 'white', fontFamily: 'monospace',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 1px 6px rgba(0,0,0,0.15)',
          transition: 'background 0.2s',
        }}
        title="Debug report"
      >
        {count > 0 ? count : '⬡'}
      </button>

      {/* Report panel */}
      {open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 950,
          background: 'rgba(30,22,16,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        }} onClick={() => setOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#1E1610', borderRadius: '20px 20px 0 0',
            width: '100%', maxWidth: 480, maxHeight: '70vh',
            padding: '16px 16px 36px', display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#C8A97E' }}>
                🐛 Debug — {store.errors.length} error{store.errors.length !== 1 ? 's' : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { debug.clear(); setReport(debug.report()); setCount(0); }}
                  style={{ background: 'none', border: '1px solid #444', borderRadius: 6, padding: '3px 8px', fontSize: 11, color: '#888', cursor: 'pointer' }}>
                  Clear
                </button>
                <button onClick={copy}
                  style={{ background: copied ? '#5A7A5A' : '#C8A97E', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 11, color: 'white', cursor: 'pointer', transition: 'background 0.2s' }}>
                  {copied ? '✓ Copied' : 'Copy report'}
                </button>
              </div>
            </div>
            <pre style={{
              margin: 0, flex: 1, overflowY: 'auto',
              fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55,
              color: '#D0C0A8', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {report || '— no data —'}
            </pre>
            <div style={{ fontSize: 10, color: '#554438', fontFamily: 'monospace', textAlign: 'center' }}>
              Tap outside to close · paste report to Claude to fix
            </div>
          </div>
        </div>
      )}
    </>
  );
}
