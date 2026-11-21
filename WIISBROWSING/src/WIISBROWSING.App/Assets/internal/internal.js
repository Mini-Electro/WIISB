'use strict';
// Shared plumbing for every wiisb:// page. Nothing here uses innerHTML with data: elements are built with textContent,
// so a page title or a URL can never turn into markup.

window.__errs = [];
addEventListener('error', (e) => window.__errs.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason && e.reason.message || e.reason)));

const WB = {
  pages: {},
  ctx: null,
  pending: new Map(),
  nextId: 1,
};

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'disabled') e.disabled = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

function api(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = WB.nextId++;
    WB.pending.set(id, { resolve, reject });
    window.chrome.webview.postMessage({ id, cmd, args });
    setTimeout(() => { if (WB.pending.has(id)) { WB.pending.delete(id); reject(new Error('The browser did not answer.')); } }, 60000);
  });
}

window.chrome.webview.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.push === 'theme') { applyTheme(m); if (WB.onTheme) WB.onTheme(m); return; }
  const mid = m && m.id !== undefined ? Number(m.id) : NaN;
  if (m && WB.pending.has(mid)) {
    const p = WB.pending.get(mid); WB.pending.delete(mid);
    if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'Something went wrong.'));
  }
});

function applyTheme(t) {
  for (const [k, v] of Object.entries(t.vars || {})) document.documentElement.style.setProperty(k, v);
  document.body.dataset.dark = t.dark ? '1' : '0';
  WB.animated = t.animated; WB.themeId = t.themeId;
  if (WB.refreshBackground) WB.refreshBackground();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message || String(e)); return undefined; }
}

function modal(build) {
  const root = $('#modal-root');
  const close = () => clear(root);
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  build(box, close);
  clear(root).append(box);
  root.onmousedown = (e) => { if (e.target === root) close(); };
  const first = box.querySelector('input,select,textarea,button.accent');
  if (first) first.focus();
  document.onkeydown = (e) => { if (e.key === 'Escape' && root.firstChild) { close(); e.stopPropagation(); } };
  return close;
}

function prompt2(title, fields, okText = 'Save') {
  return new Promise((resolve) => {
    modal((box, close) => {
      const inputs = {};
      box.append(el('h2', { text: title }));
      for (const f of fields) {
        const input = f.type === 'textarea' ? el('textarea', { value: f.value || '' }) : el('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' });
        inputs[f.key] = input;
        box.append(el('div', { class: 'field' }, el('label', { text: f.label }), input));
      }
      const done = (ok) => { const out = ok ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])) : null; close(); resolve(out); };
      box.append(el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Cancel', onclick: () => done(false) }), el('button', { class: 'btn accent', text: okText, onclick: () => done(true) })));
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') done(true); });
    });
  });
}

function confirm2(title, text, okText = 'OK') {
  return new Promise((resolve) => {
    modal((box, close) => {
      box.append(el('h2', { text: title }), el('p', { class: 'muted', text }));
      box.append(el('div', { class: 'actions' },
        el('button', { class: 'btn', text: 'Cancel', onclick: () => { close(); resolve(false); } }),
        el('button', { class: 'btn accent', text: okText, onclick: () => { close(); resolve(true); } })));
    });
  });
}

function toggle(checked, onchange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onchange(input.checked));
  return el('label', { class: 'switch' }, input, el('i'));
}

function favicon(host, title) {
  const letter = (title || host || '?').trim().charAt(0).toUpperCase() || '?';
  const box = el('span', { class: 'fav', text: letter });
  if (host) {
    const img = new Image();
    img.onload = () => { box.textContent = ''; box.append(img); };
    img.src = 'wiisb://newtab/favicon/' + encodeURIComponent(host);
  }
  return box;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function dayLabel(ms) {
  const d = new Date(ms); const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
