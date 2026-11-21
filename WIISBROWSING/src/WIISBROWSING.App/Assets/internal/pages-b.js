'use strict';

// ============================ Settings ============================

WB.pages.settings = async function (root, ctx) {
  let s = await api('settings.get');
  const V = () => s.values;
  const set = async (key, value) => { const ok = await guard(() => api('settings.set', { key, value })); if (ok !== undefined) s.values[key] = String(value); return ok; };

  const row = (title, desc, control) => el('div', { class: 'setting' }, el('div', { class: 'what' }, el('b', { text: title }), desc ? el('div', { text: desc }) : null), control);
  const sw = (key, title, desc) => row(title, desc, toggle(V()[key] === 'true', (v) => set(key, v)));
  const sel = (key, title, desc, opts) => row(title, desc, (() => { const e = el('select', {}, ...opts.map(([v, n]) => el('option', { value: v, text: n, selected: V()[key] === v }))); e.onchange = () => set(key, e.value); return e; })());
  const num = (key, title, desc, min, max) => row(title, desc, (() => { const e = el('input', { type: 'number', value: V()[key], min, max, style: { width: '90px' } }); e.onchange = () => set(key, e.value); return e; })());
  const txt = (key, title, desc, ph) => row(title, desc, (() => { const e = el('input', { type: 'text', value: V()[key], placeholder: ph || '', style: { width: '260px' } }); e.onchange = async () => { const r = await set(key, e.value); if (r === undefined) e.value = V()[key]; }; return e; })());
  const btn = (label, fn, cls = '') => el('button', { class: 'btn ' + cls, text: label, onclick: fn });

  const sections = {
    general: async () => { const upd = await api('update.info'); return [
      sel('startup.mode', 'When WIISBROWSING starts', 'Restoring brings back your tabs, workspaces and clusters.', [['restore', 'Restore my last session'], ['newtab', 'Open a new tab page'], ['blank', 'Open a blank page'], ['url', 'Open specific pages']]),
      txt('startup.urls', 'Start-up pages', 'A JSON list, for example ["https://example.com"]. Used with “Open specific pages”.', '["https://…"]'),
      txt('home.url', 'Home page', 'Where the Home button goes.', 'wiisb://newtab'),
      sw('tabs.confirmCloseMany', 'Ask before closing a window with many tabs'),
      row('Update automatically', 'Quietly download new versions of WIISBROWSING in the background. Nothing restarts until you choose “Restart now”.', toggle(upd.auto, (v) => guard(() => api('update.setAuto', { value: v })))),
      row('Check for updates', 'Version ' + upd.version + '. Look for a newer version right now.', btn('Check for updates', async (e) => { const b = e.target; b.disabled = true; b.textContent = 'Checking…'; const r = await guard(() => api('update.check')); b.disabled = false; b.textContent = 'Check for updates'; if (r) toast(r.message); })),
      row('Default browser', 'Windows decides which browser is the default. This opens the page where you choose.', btn('Open Windows default apps', () => api('cmd.run', { id: 'app.setDefault' }))),
    ]; },
    appearance: () => [
      row('Themes', 'Fifteen themes, a colour editor, import and export — all free.', el('a', { class: 'btn accent', href: 'wiisb://themes/', text: 'Open themes' })),
      sw('ui.reduceMotion', 'Reduce motion', 'Turns off decorative animation and animated backgrounds.'),
      sw('perf.gaming', 'Gaming mode', 'Calmer animations and quicker tab sleeping. It only tunes WIISBROWSING — it never touches your games.'),
      row('New tab background image', 'PNG, JPEG, WebP or BMP, up to 30 MB.', el('div', { class: 'row' }, btn('Choose image…', async () => { if (await guard(() => api('theme.pickWallpaper'))) toast('Background set. Open a new tab to see it.'); }), btn('Remove', async () => { await api('theme.clearWallpaper'); toast('Background removed.'); }, 'ghost'))),
      num('newtab.wallpaperBlur', 'Background blur', '0 to 30 pixels.', 0, 30),
      num('newtab.wallpaperDim', 'Background dimming', 'Percent, 0 to 90.', 0, 90),
      txt('newtab.userName', 'Name on the new tab page', 'Used for the greeting. Stays on this PC.'),
    ],
    tabs: () => [
      sel('tabs.layout', 'Tab layout', 'Changing this never reloads your pages.', [['vertical-left', 'Vertical, left (default)'], ['vertical-right', 'Vertical, right'], ['horizontal', 'Horizontal, top'], ['compact', 'Compact vertical rail'], ['hidden', 'Hidden (keyboard only)']]),
      sw('tabs.previews', 'Tab preview cards', 'Hover a tab to see its last view. Previews live in memory only.'),
      sw('tabs.highlightRecent', 'Highlight recently used tabs', 'A small dot marks the last two tabs you used.'),
      sel('tabs.autoCluster', 'Tab clusters', 'Grouping always uses simple local rules — nothing is sent anywhere.', [['suggest', 'Suggest groups'], ['off', 'Only when I ask']]),
      txt('tabs.clusterExclude', 'Never suggest grouping these sites', 'A JSON list of domains, for example ["example.com"].', '["example.com"]'),
      sel('perf.sleepMinutes', 'Put unused tabs to sleep after', 'Sleeping tabs free their memory and reload when you come back. Playing, downloading and camera/microphone tabs never sleep.', [['0', 'Never'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['180', '3 hours']]),
      sel('perf.mode', 'Memory saving', 'Aggressive sleeps tabs three times sooner.', [['off', 'Off'], ['balanced', 'Balanced'], ['aggressive', 'Aggressive']]),
      sel('bookmarks.bar', 'Bookmarks bar', '', [['newtab', 'Only on the new tab page'], ['always', 'Always'], ['never', 'Never']]),
    ],
    sidebar: () => [
      el('div', { class: 'note', text: 'Right-click any icon in the sidebar to edit, move, remove or open it in a tab or a new window. Use the + button to add a website. Web apps open in a side panel next to your page; if a site refuses to work there, choose “Open in a tab”.' }),
      el('div', { class: 'note', text: 'Sidebar icons are the sites\' own icons, saved on this PC the first time you open them. WIISBROWSING has no partnership with these services.' }),
    ],
    search: () => [
      sel('search.engine', 'Search engine', 'Used by the address bar and the new tab page.', [...s.searchEngines.map((e) => [e.id, e.name]), ['custom', 'Custom…']]),
      txt('search.custom', 'Custom search address', 'Use {query} where the search words go, for example https://search.example/?q={query}', 'https://…/?q={query}'),
      sw('search.suggestions', 'Show search suggestions', 'Off by default: when on, what you type is sent to your search engine while you type.'),
    ],
    privacy: () => [
      sel('privacy.tracking', 'Tracking prevention', 'Uses the browser engine\'s own protection against cross-site tracking.', [['off', 'Off'], ['balanced', 'Balanced'], ['strict', 'Strict (may break some sites)']]),
      el('div', { class: 'note', text: 'What this does and doesn\'t do: it limits cross-site tracking and blocks known ad hosts. It does not make you anonymous, hide your IP address, or stop sites from fingerprinting your browser. Private windows keep nothing on this PC — they are not invisible to websites, your employer or your internet provider.' }),
      row('Clear browsing data', 'Removes data from this profile. Bookmarks and downloaded files are kept.', el('div', { class: 'row' }, ...[['history', 'History'], ['cookies', 'Cookies'], ['cache', 'Cache'], ['sitedata', 'All site data']].map(([k, n]) => btn(n, async () => { if (await confirm2('Clear ' + n.toLowerCase() + '?', 'This can sign you out of websites.', 'Clear')) { await guard(() => api('data.clear', { kind: k })); toast(n + ' cleared.'); } })))),
      el('h3', { text: 'Site permissions' }), permissionsList(),
      el('h3', { text: 'Passwords' }), el('div', { class: 'note', text: 'Saving and filling passwords is handled by the browser engine\'s own built-in password manager (it offers to save when you sign in). WIISBROWSING has no separate password vault yet, never reads your passwords, and does not export them.' }),
    ],
    adblock: () => adblockSection(),
    downloads: () => [
      row('Download folder', V()['downloads.dir'] || 'Your Downloads folder', btn('Change…', async () => { const f = await guard(() => api('downloads.pickFolder')); if (f) { s.values['downloads.dir'] = f; toast('Saved.'); show('downloads'); } })),
      sw('downloads.ask', 'Ask where to save each file'),
      el('div', { class: 'note', text: 'Downloads are never opened automatically. Programs and scripts show a warning before they open, and every file is marked as coming from the internet so Windows can apply its own checks.' }),
    ],
    profiles: () => [row('Profiles', 'Each profile has its own cookies, history, bookmarks, permissions and tabs.', el('a', { class: 'btn accent', href: 'wiisb://profiles/', text: 'Manage profiles' }))],
    performance: () => [row('WIISB Control', 'Live memory and CPU of the browser, tab sleeping and resource modes.', el('a', { class: 'btn accent', href: 'wiisb://performance/', text: 'Open WIISB Control' }))],
    assistant: () => [el('div', { class: 'note', text: 'The WIISB Assistant (AI side panel) is not built yet. The browser works fully without any AI service, and nothing about your pages or tabs is ever sent to one.' })],
    accessibility: () => [
      sw('ui.reduceMotion', 'Reduce motion'),
      row('Text size and density', 'Pick a theme with a roomier density, or edit one in the theme editor (Density, Corner radius, Font).', el('a', { class: 'btn', href: 'wiisb://themes/', text: 'Open theme editor' })),
      el('div', { class: 'note', text: 'Keyboard: every command is on Ctrl+K, all controls can be reached with Tab, and focus is always visible. Page zoom works with Ctrl+Plus / Ctrl+Minus / Ctrl+0.' }),
    ],
    shortcuts: () => [shortcutsTable()],
    transfer: () => transferSection(),
    advanced: () => [
      sel('net.proxyMode', 'Proxy', 'Applies to new windows. A proxy changes where this browser\'s traffic goes — it is not a VPN and does not protect other apps.', [['system', 'Use the Windows setting'], ['none', 'No proxy'], ['custom', 'Custom proxy']]),
      txt('net.proxyServer', 'Proxy server', 'For example proxy.example.com:8080 or socks5://127.0.0.1:1080', 'host:port'),
      row('Data folder', 'Profiles, logs and caches.', el('div', { class: 'row' }, btn('Open data folder', () => api('about.openFolder', { which: 'data' })), btn('Open logs', () => api('about.openFolder', { which: 'logs' })))),
      row('Reset settings', 'Puts every setting in this profile back to its default. Bookmarks and history are kept.', btn('Reset…', async () => { if (await confirm2('Reset settings?', 'All settings in this profile return to defaults.', 'Reset')) { await api('settings.reset'); s = await api('settings.get'); toast('Settings reset.'); show('advanced'); } }, 'danger')),
    ],
    about: () => [row('About WIISBROWSING', 'Version, engine and data locations.', el('a', { class: 'btn', href: 'wiisb://about/', text: 'Open About' }))],
  };
  const names = { general: 'General', appearance: 'Appearance', tabs: 'Tabs', sidebar: 'Sidebar', search: 'Search', privacy: 'Privacy & Security', adblock: 'Ad blocking', downloads: 'Downloads', profiles: 'Profiles', performance: 'Performance', assistant: 'AI', accessibility: 'Accessibility', shortcuts: 'Keyboard shortcuts', transfer: 'Import & backup', advanced: 'Advanced', about: 'About' };

  const content = el('div'), nav = el('div', { class: 'nav' });
  const show = async (key) => {
    location.hash = key;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.key === key));
    clear(content).append(el('h1', { text: names[key] }));
    const parts = await sections[key]();
    content.append(el('div', { class: 'card', style: { marginTop: '14px' } }, parts));
  };
  for (const k of Object.keys(names)) nav.append(el('button', { 'data-key': k, text: names[k], onclick: () => show(k) }));
  root.append(el('div', { class: 'page' }, el('div', { class: 'settings' }, nav, content)));
  show(sections[location.hash.slice(1)] ? location.hash.slice(1) : 'general');
};

function permissionsList() {
  const box = el('div');
  const draw = async () => {
    const list = await api('permissions.list'); clear(box);
    if (!list.length) { box.append(el('p', { class: 'muted', text: 'No saved site permissions. Sites ask first; nothing is allowed silently.' })); return; }
    box.append(el('table', {}, el('tr', {}, el('th', { text: 'Site' }), el('th', { text: 'Permission' }), el('th', { text: 'Decision' }), el('th')), list.map((p) => el('tr', {}, el('td', { text: p.origin }), el('td', { text: p.permission }), el('td', { text: p.state === 'allow' ? 'Allowed' : 'Blocked' }), el('td', {}, el('button', { class: 'btn ghost', text: 'Revoke', onclick: async () => { await api('permissions.revoke', { origin: p.origin, permission: p.permission }); draw(); } }))))),
      el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn danger', text: 'Revoke all', onclick: async () => { await api('permissions.revokeAll'); draw(); } })));
  };
  draw();
  return box;
}

function adblockSection() {
  const box = el('div');
  const draw = async () => {
    const i = await api('adblock.info'); const s = await api('settings.get'); clear(box);
    box.append(el('div', { class: 'setting' }, el('div', { class: 'what' }, el('b', { text: 'Block ads and trackers' }), el('div', { text: 'Blocks requests to known advertising and tracking hosts.' })), toggle(i.enabled, (v) => api('settings.set', { key: 'privacy.adblock', value: v }))),
      el('div', { class: 'grid', style: { margin: '14px 0' } }, el('div', { class: 'card' }, el('div', { class: 'stat', text: i.total.toLocaleString() }), el('div', { class: 'muted small', text: 'requests blocked since the browser started' })), el('div', { class: 'card' }, el('div', { class: 'stat', text: i.rules.toLocaleString() }), el('div', { class: 'muted small', text: 'domain rules loaded' })), el('div', { class: 'card' }, el('div', { class: 'stat', text: i.unsupported.toLocaleString() }), el('div', { class: 'muted small', text: 'list lines skipped (not supported)' }))),
      el('div', { class: 'note', text: 'How it works, honestly: the filter matches requests by host name (rules like ||example.com^). It cannot do cosmetic filtering, script rules or path patterns, and it cannot block ads served from a site\'s own domain. Those lines are counted above and skipped. A small built-in list is always loaded; you can add the public EasyList and EasyPrivacy lists below.' }),
      el('div', { class: 'toolbar' }, el('button', { class: 'btn accent', text: 'Download EasyList + EasyPrivacy', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Downloading…'; const r = await guard(() => api('adblock.update')); if (r) toast(r.results.every((x) => x.ok) ? `Updated: ${r.rules.toLocaleString()} domain rules.` : 'Some lists could not be downloaded: ' + r.results.filter((x) => !x.ok).map((x) => x.name).join(', ')); draw(); } }),
        el('button', { class: 'btn', text: 'Reset counters', onclick: async () => { await api('adblock.resetCounters'); draw(); } })),
      i.lists && i.lists.length ? el('p', { class: 'muted small', text: 'Lists on disk: ' + i.lists.map((l) => `${l.name} (${fmtBytes(l.size)})`).join(', ') + '. EasyList is published by its authors under its own licence; it is downloaded to your PC when you press the button, not bundled.' }) : null,
      el('h3', { text: 'Sites where blocking is off' }),
      i.exceptions.length ? el('div', { class: 'list' }, i.exceptions.map((h) => el('div', { class: 'item' }, el('span', { class: 'grow', text: h }), el('button', { class: 'btn ghost', text: 'Remove', onclick: async () => { await api('adblock.removeException', { host: h }); draw(); } })))) : el('p', { class: 'muted', text: 'None. Use the shield icon in the address bar to turn blocking off for one site.' }),
      el('h3', { text: 'Recently blocked' }),
      i.recent.length ? el('table', {}, i.recent.slice(0, 15).map((r) => el('tr', {}, el('td', { text: r.host }), el('td', { class: 'muted', text: r.rule || '' }), el('td', { class: 'muted', text: fmtTime(r.at) })))) : el('p', { class: 'muted', text: 'Nothing blocked yet.' }));
  };
  draw();
  return [box];
}

function shortcutsTable() {
  const box = el('div');
  const draw = async () => {
    const list = await api('shortcuts.list'); clear(box);
    box.append(el('div', { class: 'toolbar' }, el('button', { class: 'btn', text: 'Restore default shortcuts', onclick: async () => { await api('shortcuts.reset'); draw(); } })),
      el('div', { class: 'note', text: 'Windows shortcuts (Alt+F4) and editing shortcuts (Ctrl+C, V, X, A, Z, Y) can\'t be reassigned. If two commands share a shortcut you\'ll be told.' }));
    let cat = '';
    const table = el('table', {});
    for (const c of list) {
      if (c.category !== cat) { cat = c.category; table.append(el('tr', {}, el('th', { colspan: 3, text: cat }))); }
      table.append(el('tr', {}, el('td', { text: c.name }), el('td', {}, c.chord ? el('span', { class: 'kbd', text: c.chord }) : el('span', { class: 'muted', text: 'none' })),
        el('td', {}, el('button', { class: 'btn ghost', text: 'Change', onclick: () => capture(c, draw) }))));
    }
    box.append(table);
  };
  draw();
  return box;
}

function capture(c, done) {
  modal((box, close) => {
    box.append(el('h2', { text: 'Shortcut for “' + c.name + '”' }), el('p', { class: 'muted', text: 'Press the new key combination now, or Esc to cancel.' }));
    const out = el('div', { class: 'stat', style: { textAlign: 'center', margin: '16px 0' }, text: '…' }); box.append(out);
    const keyName = (e) => {
      const k = e.key; if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
      if (k === ' ') return 'Space'; if (k === '+' || k === '=') return 'Plus'; if (k === '-' ) return 'Minus';
      if (k.length === 1) return k.toUpperCase(); return k.replace('Arrow', '');
    };
    const handler = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { document.removeEventListener('keydown', handler, true); close(); return; }
      const k = keyName(e); if (!k) return;
      const chord = [e.ctrlKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', k].filter(Boolean).join('+');
      out.textContent = chord;
      document.removeEventListener('keydown', handler, true);
      const r = await guard(() => api('shortcuts.set', { id: c.id, chord }));
      if (r && r.ok) { close(); done(); toast('Shortcut saved.'); } else if (r) { out.textContent = chord; box.append(el('p', { style: { color: '#fb7185' }, text: r.error })); document.addEventListener('keydown', handler, true); }
    };
    document.addEventListener('keydown', handler, true);
    box.append(el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Remove shortcut', onclick: async () => { document.removeEventListener('keydown', handler, true); await api('shortcuts.set', { id: c.id, chord: '' }); close(); done(); } }), el('button', { class: 'btn', text: 'Cancel', onclick: () => { document.removeEventListener('keydown', handler, true); close(); } })));
  });
}

function transferSection() {
  const box = el('div');
  (async () => {
    const found = await api('import.detect');
    box.append(el('h3', { text: 'Import bookmarks from another browser' }), el('p', { class: 'muted', text: 'WIISBROWSING only reads the other browser\'s bookmarks file (a copy of it) and never changes it. History, passwords and cookies are not imported.' }));
    if (!found.length) box.append(el('p', { class: 'muted', text: 'No supported browsers were found on this PC.' }));
    for (const b of found) box.append(el('div', { class: 'item' }, el('span', { class: 'grow', text: b.name }), el('button', { class: 'btn', text: 'Import bookmarks', onclick: async () => { const r = await guard(() => api('import.run', { id: b.id })); if (r) toast(`Imported ${r.added} bookmarks from ${r.name} (${r.skipped} skipped).`); } })));
    box.append(el('h3', { text: 'Backup' }), el('p', { class: 'muted', text: 'A backup holds bookmarks, notes, Speed Dial, workspaces and custom themes. It does not contain cookies, passwords or history. Restoring merges — it never overwrites what you have.' }),
      el('div', { class: 'row' }, el('button', { class: 'btn accent', text: 'Create backup…', onclick: async () => { const r = await guard(() => api('backup.export')); if (r && r.saved) toast('Backup saved.'); } }),
        el('button', { class: 'btn', text: 'Restore from backup…', onclick: async () => { const r = await guard(() => api('backup.import')); if (r) toast(`Restored ${r.bookmarks} bookmarks, ${r.notes} notes and ${r.themes} themes.`); } }),
        el('button', { class: 'btn', text: 'Export bookmarks (HTML)…', onclick: () => guard(() => api('bookmarks.export')) })));
  })();
  return [box];
}

// ============================ Themes ============================

WB.pages.themes = async function (root) {
  const state = await api('theme.list');
  let draft = null;
  const gallery = el('div'), editor = el('div');
  const colorTokens = state.tokens;
  const alphaTokens = new Set(['Hover', 'BorderSubtle']);
  const hexToParts = (h) => ({ rgb: '#' + h.slice(1, 7), a: h.length === 9 ? parseInt(h.slice(7, 9), 16) : 255 });
  const toHex = (rgb, a) => rgb.toLowerCase() + (a < 255 ? a.toString(16).padStart(2, '0') : '');
  const kebab = (t) => '--' + t.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  const drawGallery = () => {
    clear(gallery).append(el('div', { class: 'theme-grid' }, state.themes.map((t) => themeCard(t, t.id === state.current, async () => { await guard(() => api('theme.select', { id: t.id })); state.current = t.id; draw(); }))));
  };
  const startEdit = (t) => { draft = JSON.parse(JSON.stringify(t)); draft.id = t.builtIn ? '' : t.id; if (t.builtIn) draft.name = t.name + ' (custom)'; drawEditor(); };
  const preview = () => {
    const box = $('#theme-preview'); if (!box || !draft) return;
    for (const tk of colorTokens) box.style.setProperty(kebab(tk), draft.colors[tk]);
    box.style.setProperty('--radius', draft.cornerRadius + 'px'); box.style.fontFamily = `'${draft.fontFamily}', 'Segoe UI', sans-serif`;
  };
  const drawEditor = () => {
    clear(editor);
    if (!draft) { editor.append(el('div', { class: 'toolbar' }, el('button', { class: 'btn accent', text: 'Create a custom theme', onclick: () => startEdit(state.themes.find((t) => t.id === state.current) || state.themes[0]) }), el('button', { class: 'btn', text: 'Import theme…', onclick: importTheme }))); return; }
    const fields = colorTokens.map((tk) => {
      const parts = hexToParts(draft.colors[tk]);
      const color = el('input', { type: 'color', value: parts.rgb, 'aria-label': tk });
      const alpha = alphaTokens.has(tk) ? el('input', { type: 'range', min: 0, max: 255, value: parts.a, title: 'Opacity' }) : null;
      const upd = () => { draft.colors[tk] = toHex(color.value, alpha ? parseInt(alpha.value, 10) : 255); preview(); };
      color.oninput = upd; if (alpha) alpha.oninput = upd;
      return el('div', { class: 'row', style: { minWidth: '230px' } }, color, el('span', { class: 'grow', text: tk.replace(/([a-z])([A-Z])/g, '$1 $2') }), alpha);
    });
    const num = (label, key, min, max, step) => el('div', { class: 'field' }, el('label', { text: label + ': ' }), el('input', { type: 'range', min, max, step, value: draft[key], oninput: (e) => { draft[key] = parseFloat(e.target.value); preview(); } }));
    editor.append(el('h2', { text: 'Theme editor' }),
      el('div', { id: 'theme-preview', class: 'card', style: { display: 'grid', gridTemplateColumns: '60px 150px 1fr', gap: 0, padding: 0, overflow: 'hidden', height: '170px', background: 'var(--background-primary)', color: 'var(--text-primary)', borderRadius: 'var(--radius)' } },
        el('div', { style: { background: 'var(--sidebar)' } }), el('div', { style: { background: 'var(--background-secondary)', padding: '12px 8px' } }, el('div', { style: { background: 'var(--tab-active)', borderRadius: '8px', padding: '6px 8px', marginBottom: '6px' }, text: 'Active tab' }), el('div', { style: { background: 'var(--tab)', borderRadius: '8px', padding: '6px 8px' }, text: 'Another tab' })),
        el('div', { style: { padding: '14px' } }, el('div', { style: { background: 'var(--address-bar)', border: '1px solid var(--border-subtle)', borderRadius: '999px', padding: '6px 14px', marginBottom: '12px' }, text: 'Search or enter address' }), el('span', { style: { background: 'var(--accent-primary)', color: '#fff', padding: '5px 12px', borderRadius: 'var(--radius)' }, text: 'Accent' }), el('p', { style: { color: 'var(--text-muted)' }, text: 'Muted text sample' }))),
      el('div', { class: 'field' }, el('label', { text: 'Name' }), el('input', { type: 'text', value: draft.name, oninput: (e) => draft.name = e.target.value })),
      el('div', { class: 'grid' }, fields), num('Corner radius', 'cornerRadius', 0, 32, 1), num('Density (0.8 compact – 1.3 roomy)', 'density', 0.7, 1.4, 0.05), num('Shadow strength', 'shadowStrength', 0, 1, 0.05), num('Animation speed (0 = none)', 'animationScale', 0, 2, 0.1),
      el('div', { class: 'row' }, el('div', { class: 'field grow' }, el('label', { text: 'Font' }), el('select', { onchange: (e) => { draft.fontFamily = e.target.value; preview(); } }, ...['Segoe UI Variable Text', 'Segoe UI', 'Bahnschrift', 'Consolas', 'Georgia', 'Trebuchet MS', 'Verdana', 'Calibri'].map((f) => el('option', { value: f, text: f, selected: draft.fontFamily === f })))),
        el('div', { class: 'field grow' }, el('label', { text: 'New tab animation' }), el('select', { onchange: (e) => draft.animated = e.target.value }, ...['none', 'gradient', 'stars', 'particles'].map((f) => el('option', { value: f, text: f, selected: draft.animated === f })))),
        el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: draft.isDark, onchange: (e) => draft.isDark = e.target.checked }), el('span', { text: 'Dark theme' }))),
      el('div', { class: 'toolbar' }, el('button', { class: 'btn accent', text: 'Save and apply', onclick: async () => { const r = await guard(() => api('theme.save', { theme: draft })); if (r) { toast('Theme saved.'); location.reload(); } } }), el('button', { class: 'btn', text: 'Cancel', onclick: () => { draft = null; drawEditor(); } })));
    preview();
  };
  const importTheme = () => modal((box, close) => {
    const ta = el('textarea', { placeholder: 'Paste theme JSON here' });
    box.append(el('h2', { text: 'Import a theme' }), el('p', { class: 'muted', text: 'Themes are plain data. Anything that isn\'t a known colour or number is rejected.' }), ta,
      el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Cancel', onclick: close }), el('button', { class: 'btn accent', text: 'Import', onclick: async () => { const r = await guard(() => api('theme.import', { json: ta.value })); if (r) { close(); location.reload(); } } })));
  });
  const actions = el('div', { class: 'toolbar' });
  const draw = () => {
    drawGallery(); clear(actions);
    const cur = state.themes.find((t) => t.id === state.current);
    actions.append(el('button', { class: 'btn', text: 'Duplicate and edit', onclick: () => startEdit(cur) }),
      cur && !cur.builtIn ? el('button', { class: 'btn', text: 'Edit this theme', onclick: () => startEdit(cur) }) : null,
      el('button', { class: 'btn', text: 'Export…', onclick: async () => { const j = await api('theme.export', { id: state.current }); modal((box, close) => { box.append(el('h2', { text: 'Theme JSON' }), el('textarea', { readonly: true, value: j, style: { minHeight: '260px' } }), el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Copy', onclick: () => { navigator.clipboard.writeText(j); toast('Copied.'); } }), el('button', { class: 'btn accent', text: 'Done', onclick: close }))); }); } }),
      cur && !cur.builtIn ? el('button', { class: 'btn danger', text: 'Delete this theme', onclick: async () => { if (await confirm2('Delete theme?', cur.name, 'Delete')) { await api('theme.delete', { id: cur.id }); location.reload(); } } }) : null,
      el('button', { class: 'btn ghost', text: 'Restore default theme', onclick: async () => { await api('theme.select', { id: 'midnight' }); location.reload(); } }));
  };
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Themes' }), el('p', { class: 'lead', text: 'Every theme is free. Colour changes apply instantly, with no restart.' }), gallery, actions, editor));
  draw(); drawEditor();
};

// ============================ WIISB Control (performance) ============================

WB.pages.performance = async function (root) {
  const cards = el('div', { class: 'grid' }), procs = el('div'), tabs = el('div'), modes = el('div', { class: 'toolbar' });
  let stopped = false;
  const stat = (v, l) => el('div', { class: 'card' }, el('div', { class: 'stat', text: v }), el('div', { class: 'muted small', text: l }));
  const refresh = async () => {
    if (stopped) return;
    const p = await api('perf.get');
    clear(cards).append(stat(p.memoryMb.toLocaleString() + ' MB', 'browser memory (app + engine processes)'), stat(p.cpu + '%', `browser CPU (of ${p.cores} cores)`), stat(`${p.tabsActive} / ${p.tabs}`, 'tabs loaded / total'), stat(String(p.tabsSleeping), 'sleeping tabs'), stat(String(p.processes), 'browser processes'), stat(String(p.downloads), 'running downloads'), stat(p.adblockTotal.toLocaleString(), 'ads & trackers blocked'));
    clear(procs).append(el('table', {}, el('tr', {}, el('th', { text: 'Process' }), el('th', { text: 'PID' }), el('th', { text: 'Memory' }), el('th', { text: 'CPU' })), p.processList.sort((a, b) => b.memoryMb - a.memoryMb).map((r) => el('tr', {}, el('td', { text: r.kind }), el('td', { text: r.pid }), el('td', { text: r.memoryMb + ' MB' }), el('td', { text: r.cpu + '%' })))));
    const t = await api('perf.tabs');
    clear(tabs).append(el('table', {}, el('tr', {}, el('th', { text: 'Tab' }), el('th', { text: 'Workspace' }), el('th', { text: 'State' }), el('th', { text: 'Idle' }), el('th')), t.map((x) => el('tr', {}, el('td', { text: x.title }), el('td', { text: x.workspace || '' }), el('td', { text: x.state + (x.audible ? ' · playing' : '') }), el('td', { text: x.idleMinutes + ' min' }), el('td', {}, x.canSleep ? el('button', { class: 'btn ghost', text: 'Sleep now', onclick: async () => { await api('perf.sleepTab', { id: x.id }); refresh(); } }) : null)))));
    drawModes(p);
  };
  const setMode = async (mode, minutes) => { await api('settings.set', { key: 'perf.mode', value: mode }); await api('settings.set', { key: 'perf.sleepMinutes', value: String(minutes) }); refresh(); toast('Mode applied.'); };
  const drawModes = (p) => {
    const cur = p.mode === 'off' ? 'perf' : p.mode === 'balanced' ? 'bal' : p.sleepMinutes <= 5 ? 'mem' : 'bat';
    clear(modes).append(...[['perf', 'Performance', 'Tabs never sleep', () => setMode('off', 0)], ['bal', 'Balanced', 'Sleep after 30 min', () => setMode('balanced', 30)], ['bat', 'Battery saver', 'Sleep after 10 min', () => setMode('aggressive', 10)], ['mem', 'Memory saver', 'Sleep after 5 min', () => setMode('aggressive', 5)]].map(([k, n, d, f]) => el('button', { class: 'chip' + (cur === k ? ' on' : ''), title: d, text: n, onclick: f })),
      el('button', { class: 'chip' + (p.gaming ? ' on' : ''), text: '🎮 Gaming mode', onclick: async () => { await api('settings.set', { key: 'perf.gaming', value: String(!p.gaming) }); refresh(); } }));
  };
  root.append(el('div', { class: 'page' }, el('h1', { text: 'WIISB Control' }), el('p', { class: 'lead', text: 'Real numbers from Windows about the browser\'s own processes — refreshed every two seconds.' }), modes, cards,
    el('h2', { text: 'Tabs' }), tabs, el('h2', { text: 'Processes' }), procs,
    el('div', { class: 'note', text: 'What this can and can\'t do: the browser saves memory by putting unused tabs to sleep (their page process is closed and rebuilt when you return). It does not set hard CPU or memory limits per tab — the engine doesn\'t offer a safe way to, and caps that crash pages would be worse than useless. Sleeping restores the address and scroll position, not unsaved form text or the state of a running web app.' })));
  await refresh();
  const timer = setInterval(() => { if (document.hidden) return; refresh().catch(() => {}); }, 2000);
  addEventListener('unload', () => { stopped = true; clearInterval(timer); });
};

// ============================ Profiles ============================

WB.pages.profiles = async function (root, ctx) {
  const list = el('div', { class: 'grid' });
  const draw = async () => {
    const ps = await api('profiles.list'); clear(list);
    for (const p of ps) list.append(el('div', { class: 'card' }, el('div', { class: 'row' }, el('span', { class: 'fav', style: { background: p.color, color: '#fff', width: '34px', height: '34px', fontSize: '16px' }, text: p.name[0].toUpperCase() }), el('div', { class: 'grow' }, el('b', { text: p.name }), el('div', { class: 'muted small', text: p.current ? 'This window' : p.open ? 'Open' : 'Not open' }))),
      el('div', { class: 'row', style: { marginTop: '12px' } }, el('button', { class: 'btn', text: p.current ? 'Current' : 'Open', disabled: p.current, onclick: () => api('profiles.open', { id: p.id }) }),
        el('button', { class: 'btn ghost', text: 'Rename', onclick: async () => { const r = await prompt2('Rename profile', [{ key: 'name', label: 'Name', value: p.name }]); if (r) { await guard(() => api('profiles.rename', { id: p.id, name: r.name })); draw(); } } }),
        el('button', { class: 'btn ghost danger', text: 'Delete', disabled: p.current || p.open || ps.length < 2, onclick: async () => { if (await confirm2('Delete profile “' + p.name + '”?', 'Its cookies, history, bookmarks, notes and saved sessions are removed from this PC. This can\'t be undone.', 'Delete profile')) { await guard(() => api('profiles.delete', { id: p.id, deleteData: true })); draw(); } } }))));
    list.append(el('button', { class: 'card', style: { textAlign: 'center', borderStyle: 'dashed', color: 'var(--text-muted)' }, text: '+ Add profile', onclick: async () => { const r = await prompt2('New profile', [{ key: 'name', label: 'Name', placeholder: 'Work, Gaming, School…' }], 'Create'); if (r && r.name) { await guard(() => api('profiles.create', { name: r.name, color: '#8B5CF6' })); draw(); } } }));
  };
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Profiles' }), el('p', { class: 'lead', text: 'Each profile is separate: its own cookies and logins, history, bookmarks, site permissions, notes, workspaces and open tabs. Nothing is shared between profiles.' }), list));
  draw();
};

// ============================ Extensions ============================

WB.pages.extensions = async function (root) {
  const list = el('div');
  const draw = async () => {
    const r = await api('extensions.list'); clear(list);
    if (!r.available) list.append(el('p', { class: 'muted', text: 'Open a web page in a tab first — extensions are managed through a live page.' }));
    if (!r.extensions.length) list.append(el('div', { class: 'empty', text: 'No extensions are installed.' }));
    for (const e of r.extensions) list.append(el('div', { class: 'item' }, el('div', { class: 'grow' }, el('div', { class: 'title', text: e.name }), el('div', { class: 'sub', text: 'ID ' + e.id + (e.permissions.length ? ' · permissions: ' + e.permissions.join(', ') : '') })),
      toggle(e.enabled, async (v) => { await guard(() => api('extensions.enable', { id: e.id, enabled: v })); }),
      el('button', { class: 'btn danger', text: 'Remove', onclick: async () => { if (await confirm2('Remove extension?', e.name, 'Remove')) { await guard(() => api('extensions.remove', { id: e.id })); draw(); } } })));
  };
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Extensions' }), el('p', { class: 'lead', text: 'Add unpacked Chromium extensions from a folder on your PC.' }),
    el('div', { class: 'note', text: 'Honest limits: WIISBROWSING uses the WebView2 engine, which can load unpacked extensions with manifest version 2 or 3 but does not include the Chrome Web Store, automatic updates or every extension API (for example, toolbar buttons and some browser-level APIs are missing). Extensions are code that can read the pages you visit — only add ones you trust and have reviewed. No Chrome Web Store compatibility is claimed.' }),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn accent', text: 'Add unpacked extension…', onclick: async () => { const r = await guard(() => api('extensions.add')); if (r) { toast('Added ' + r.name); draw(); } } })), list));
  draw();
};

// ============================ About / Help / Privacy / Tools ============================

WB.pages.about = async function (root) {
  const i = await api('about.info');
  const rows = [['Version', i.version], ['Browser engine', 'Microsoft Edge WebView2 (Chromium) ' + i.engine], ['.NET', i.dotnet], ['Windows', i.os], ['Profile', i.profile], ['Data folder', i.data], ['Profile folder', i.profileFolder], ['Logs', i.logs]];
  root.append(el('div', { class: 'page' }, el('div', { class: 'row' }, el('img', { src: 'logo.png', width: 72, height: 72, alt: '' }), el('div', {}, el('h1', { text: 'WIISBROWSING' }), el('div', { class: 'muted', text: 'Your internet. Reimagined.' }))),
    el('div', { class: 'card', style: { marginTop: '24px' } }, el('table', {}, rows.map(([k, v]) => el('tr', {}, el('td', { class: 'muted', text: k }), el('td', { text: v }))))),
    el('p', { class: 'muted', text: 'The web engine is updated by Microsoft through the WebView2 Runtime (Windows Update / Edge updater). WIISBROWSING updates itself (Settings → General): the installed copy downloads new versions in the background.' }),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', text: 'Open data folder', onclick: () => api('about.openFolder', { which: 'data' }) }), el('button', { class: 'btn', text: 'Open logs', onclick: () => api('about.openFolder', { which: 'logs' }) }), el('a', { class: 'btn', href: 'wiisb://help/', text: 'What works and what doesn\'t' }))));
};

WB.pages.help = async function (root) {
  const done = ['Real web browsing on the Chromium engine (WebView2)', 'Vertical, horizontal, compact, right-side and hidden tab layouts without reloading pages', 'Workspaces and WIISB Clusters (manual + local suggestions)', 'Pinned tabs, drag to reorder, recently closed tabs, duplicate finder, tab search, sleeping tabs', 'Address bar with history, bookmark and open-tab suggestions; Ctrl+K command bar', 'History, bookmarks (import/export), downloads with pause/resume, session restore and crash recovery', 'Private windows with a separate throw-away data folder, profiles with separate data', 'Site permissions, certificate warnings from the engine, ad and tracker blocking by host', 'Themes (15 + editor), wallpaper, Speed Dial, reader mode, read aloud, notes, screenshots, find, print/PDF', 'WIISB Control: real memory and CPU of the browser\'s processes', 'Extensions: unpacked folders only (see the Extensions page)'];
  const notDone = ['Split-screen browsing', 'Translation (no translation engine is bundled; nothing is sent to a cloud service)', 'WIISB Assistant (AI) and any AI provider', 'Cloud sync (the browser is local-first)', 'A VPN (only a proxy setting exists, and it is not a VPN)', 'Mouse gestures', 'A built-in password manager (the engine\'s own save-and-fill is used)', 'Picture-in-picture beyond what the web page offers, annotation tools for screenshots, full-page screenshots', 'Tabs moved between windows keep their address, not their page history', 'Only the first window of a profile is saved and restored; extra windows are not'];
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Help' }), el('p', { class: 'lead', text: 'What works today, and what doesn\'t. Nothing here is a mock-up.' }),
    el('h2', { text: 'Works' }), el('ul', {}, done.map((t) => el('li', { text: t }))), el('h2', { text: 'Not available (yet)' }), el('ul', {}, notDone.map((t) => el('li', { text: t }))),
    el('h2', { text: 'Websites that refuse to sign in' }), el('p', { class: 'muted', text: 'A few sites block sign-in from embedded browsers. WIISBROWSING doesn\'t pretend to be another browser to get around that. If a site refuses, open it in your default browser instead.' }),
    el('h2', { text: 'Keyboard' }), el('p', { class: 'muted' }, 'Press ', el('span', { class: 'kbd', text: 'Ctrl+K' }), ' for every command, or see ', el('a', { href: 'wiisb://settings/#shortcuts', text: 'Settings → Keyboard shortcuts' }), '.')));
};

WB.pages.privacy = async function (root) {
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Privacy' }), el('p', { class: 'lead', text: 'What WIISBROWSING keeps, and what it never does.' }),
    el('ul', {}, ['Everything is stored on this PC under %LOCALAPPDATA%\\WIISBROWSING. Nothing is uploaded; there is no telemetry and no account.', 'Private windows use a separate, temporary data folder that is deleted when the window closes, and never write to history or to the saved session.', 'Search suggestions are off by default. When on, what you type goes to your search engine as you type.', 'Reader mode, read aloud, screenshots and notes all work locally.', 'Web pages can\'t talk to the browser: only wiisb:// pages can, and only through a fixed list of commands.'].map((t) => el('li', { text: t }))),
    el('div', { class: 'note', text: 'Limits: private windows don\'t hide your activity from websites, your network or your internet provider, and nothing here can stop all fingerprinting.' })));
};

WB.pages.error = async function (root) { root.append(el('div', { class: 'page' }, el('h1', { text: 'This page can\'t be displayed' }))); };

WB.pages.tools = async function (root) {
  const section = (title, ...kids) => el('div', { class: 'card', style: { marginBottom: '16px' } }, el('h3', { text: title, style: { marginTop: 0 } }), ...kids);
  // Calculator: a small recursive-descent parser, never eval().
  const calcIn = el('input', { type: 'text', placeholder: '(12 + 8) * 3 / 4', style: { width: '100%' } }), calcOut = el('div', { class: 'stat', text: '' });
  const evaluate = (src) => {
    let i = 0; const s = src.replace(/\s+/g, '');
    const num = () => { const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i)); if (!m) throw new Error('number expected'); i += m[0].length; return parseFloat(m[0]); };
    const atom = () => { if (s[i] === '(') { i++; const v = expr(); if (s[i++] !== ')') throw new Error('missing )'); return v; } if (s[i] === '-') { i++; return -atom(); } if (s[i] === '+') { i++; return atom(); } return num(); };
    const pow = () => { let v = atom(); while (s[i] === '^') { i++; v = Math.pow(v, atom()); } return v; };
    const term = () => { let v = pow(); while (s[i] === '*' || s[i] === '/' || s[i] === '%') { const o = s[i++]; const r = pow(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
    const expr = () => { let v = term(); while (s[i] === '+' || s[i] === '-') { const o = s[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
    const v = expr(); if (i < s.length) throw new Error('unexpected ' + s[i]); return v;
  };
  calcIn.oninput = () => { try { calcOut.textContent = calcIn.value.trim() ? String(+evaluate(calcIn.value).toPrecision(12)) : ''; } catch { calcOut.textContent = '…'; } };
  const units = { length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 }, mass: { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.0283495 }, data: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 } };
  const uv = el('input', { type: 'number', value: 1, style: { width: '110px' } }), ut = el('select', {}, ...Object.keys(units).map((k) => el('option', { value: k, text: k }))), uf = el('select'), uo = el('select'), ur = el('b', { text: '' });
  const fill = () => { for (const s of [uf, uo]) { clear(s); for (const k of Object.keys(units[ut.value])) s.append(el('option', { value: k, text: k })); } uo.selectedIndex = 1; conv(); };
  const conv = () => { const m = units[ut.value]; ur.textContent = (uv.value * m[uf.value] / m[uo.value]).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + uo.value; };
  ut.onchange = fill; [uv, uf, uo].forEach((e) => e.oninput = conv); fill();
  const color = el('input', { type: 'color', value: '#8b5cf6' }), colorOut = el('div', { class: 'muted' });
  const showColor = () => { const h = color.value, r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16); colorOut.textContent = `${h.toUpperCase()}  ·  rgb(${r}, ${g}, ${b})`; }; color.oninput = showColor; showColor();
  const enc = el('textarea', { placeholder: 'Text or URL' }), encOut = el('textarea', { readonly: true });
  const json = el('textarea', { placeholder: '{"paste":"json here"}' }), jsonMsg = el('div', { class: 'muted small' });
  const text = el('textarea', { placeholder: 'Paste text…' }), textMsg = el('div', { class: 'muted small' });
  const tr = (fn) => () => { text.value = fn(text.value); textMsg.textContent = `${text.value.length} characters · ${(text.value.trim().match(/\S+/g) || []).length} words · ${text.value ? text.value.split('\n').length : 0} lines`; };
  const tmin = el('input', { type: 'number', value: 5, min: 1, max: 600, style: { width: '80px' } }), tdisp = el('div', { class: 'stat', text: '00:00' }); let tid = 0;
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Mini tools' }), el('p', { class: 'lead', text: 'Small utilities that run entirely on this page — nothing is sent anywhere.' }),
    section('Calculator', calcIn, calcOut),
    section('Unit converter', el('div', { class: 'row' }, uv, ut, uf, el('span', { text: '→' }), uo, ur)),
    section('Colour picker', el('div', { class: 'row' }, color, colorOut)),
    section('URL encoder / decoder', enc, el('div', { class: 'toolbar', style: { marginTop: '8px' } }, el('button', { class: 'btn', text: 'Encode', onclick: () => encOut.value = encodeURIComponent(enc.value) }), el('button', { class: 'btn', text: 'Decode', onclick: () => { try { encOut.value = decodeURIComponent(enc.value); } catch { encOut.value = 'Not valid encoded text.'; } } })), encOut),
    section('JSON formatter', json, el('div', { class: 'toolbar', style: { marginTop: '8px' } }, el('button', { class: 'btn', text: 'Format', onclick: () => { try { json.value = JSON.stringify(JSON.parse(json.value), null, 2); jsonMsg.textContent = 'Valid JSON.'; } catch (e) { jsonMsg.textContent = e.message; } } }), el('button', { class: 'btn', text: 'Minify', onclick: () => { try { json.value = JSON.stringify(JSON.parse(json.value)); jsonMsg.textContent = 'Valid JSON.'; } catch (e) { jsonMsg.textContent = e.message; } } })), jsonMsg),
    section('Text', text, el('div', { class: 'toolbar', style: { marginTop: '8px' } }, el('button', { class: 'btn', text: 'UPPER', onclick: tr((v) => v.toUpperCase()) }), el('button', { class: 'btn', text: 'lower', onclick: tr((v) => v.toLowerCase()) }), el('button', { class: 'btn', text: 'Title Case', onclick: tr((v) => v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())) }), el('button', { class: 'btn', text: 'Trim lines', onclick: tr((v) => v.split('\n').map((l) => l.trim()).join('\n')) }), el('button', { class: 'btn', text: 'Sort lines', onclick: tr((v) => v.split('\n').sort((a, b) => a.localeCompare(b)).join('\n')) }), el('button', { class: 'btn', text: 'Count', onclick: tr((v) => v) })), textMsg),
    section('Quick timer', el('div', { class: 'row' }, tmin, el('span', { text: 'minutes' }), el('button', { class: 'btn accent', text: 'Start', onclick: () => { clearInterval(tid); let left = parseInt(tmin.value, 10) * 60; const show = () => { tdisp.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0'); }; show(); tid = setInterval(() => { left--; show(); if (left <= 0) { clearInterval(tid); toast('⏰ Timer finished'); tdisp.textContent = 'Done!'; } }, 1000); } }), el('button', { class: 'btn', text: 'Stop', onclick: () => { clearInterval(tid); tdisp.textContent = '00:00'; } }), tdisp)),
    el('p', { class: 'muted small', text: 'Not included: a QR code generator.' })));
};
