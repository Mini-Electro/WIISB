'use strict';

// ============================ New tab ============================

WB.pages.newtab = async function (root, ctx) {
  const data = await api('newtab.data');
  const bg = $('#bg');
  WB.refreshBackground = () => {
    bg.className = '';
    bg.style.backgroundImage = '';
    bg.style.filter = '';
    stopFx();
    if (data.hasWallpaper) {
      bg.className = 'wall';
      bg.style.backgroundImage = 'url("wiisb://newtab/wallpaper?' + Date.now() + '")';
      bg.style.filter = `blur(${data.wallpaperBlur}px) brightness(${1 - data.wallpaperDim / 100})`;
      bg.style.transform = data.wallpaperBlur ? 'scale(1.06)' : 'none';
    } else if (!ctx.reduceMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (WB.animated === 'gradient') bg.className = 'gradient';
      else if (WB.animated === 'stars' || WB.animated === 'particles') startFx(WB.animated);
    }
  };
  WB.refreshBackground();

  const clockEl = el('div', { class: 'clock' }), dateEl = el('div', { class: 'date' }), greetEl = el('div', { class: 'greeting' });
  const tick = () => {
    const n = new Date();
    clockEl.textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    dateEl.textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const h = n.getHours();
    greetEl.textContent = (h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (data.userName ? ', ' + data.userName : '');
  };
  tick(); setInterval(tick, 15000);

  const input = el('input', { type: 'text', placeholder: 'Search with ' + data.engine + ' or type an address', autofocus: true, 'aria-label': 'Search or enter address' });
  const form = el('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) guard(() => api('nav.search', { query: input.value })); } },
    el('span', { class: 'muted', text: '🔍' }), input, el('button', { class: 'btn accent', type: 'submit', text: 'Go' }));

  const tiles = el('div', { class: 'tiles' });
  const renderTiles = () => {
    clear(tiles);
    data.speedDial.forEach((s, i) => {
      const t = el('a', { class: 'tile', href: s.url, draggable: 'true', title: s.url },
        el('div', { class: 'ico' }, el('span', { text: s.title.charAt(0).toUpperCase() })),
        el('div', { class: 'name', text: s.title }),
        el('button', { class: 'btn ghost x', text: '✕', title: 'Remove', onclick: async (e) => { e.preventDefault(); e.stopPropagation(); await guard(() => api('speeddial.remove', { id: s.id })); data.speedDial.splice(i, 1); renderTiles(); } }));
      const icon = new Image(); icon.onload = () => { clear($('.ico', t)).append(icon); }; icon.src = 'wiisb://newtab/favicon/' + encodeURIComponent(s.host);
      t.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const r = await prompt2('Edit tile', [{ key: 'title', label: 'Name', value: s.title }, { key: 'url', label: 'Web address', value: s.url }]);
        if (r) { await guard(() => api('speeddial.update', { id: s.id, title: r.title, url: r.url })); location.reload(); }
      });
      t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); t.classList.add('drag'); });
      t.addEventListener('dragend', () => t.classList.remove('drag'));
      t.addEventListener('dragover', (e) => e.preventDefault());
      t.addEventListener('drop', async (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(from) || from === i) return;
        const [m] = data.speedDial.splice(from, 1); data.speedDial.splice(i, 0, m);
        await guard(() => api('speeddial.reorder', { ids: data.speedDial.map((x) => x.id) })); renderTiles();
      });
      tiles.append(t);
    });
    tiles.append(el('button', { class: 'tile add', onclick: async () => {
      const r = await prompt2('Add a site', [{ key: 'title', label: 'Name', placeholder: 'Example' }, { key: 'url', label: 'Web address', placeholder: 'https://example.com' }], 'Add');
      if (r && r.url) { await guard(() => api('speeddial.add', { title: r.title || r.url, url: r.url })); location.reload(); }
    } }, el('div', { class: 'ico', text: '+' }), el('div', { class: 'name', text: 'Add site' })));
  };
  renderTiles();

  const page = el('div', { class: 'newtab' }, clockEl, dateEl, greetEl, form);
  if (data.isPrivate) page.append(el('div', { class: 'private-banner' }, el('b', { text: 'You are in a private window' }), el('p', { class: 'muted', text: "Your history, cookies and site data from this window are thrown away when you close it. Websites, your employer or your internet provider can still see that you visited them. Downloads and bookmarks you save stay on your PC." })));
  page.append(tiles);

  if (data.topSites.length) page.append(el('div', { class: 'section' }, el('div', { class: 'label', text: 'Often visited' }),
    el('div', { class: 'chips' }, data.topSites.slice(0, 6).map((s) => el('a', { class: 'ws-chip', href: s.url }, favicon(s.host, s.title), el('span', { text: s.title || s.host }))))));
  page.append(el('div', { class: 'section' }, el('div', { class: 'label', text: 'Workspaces' }),
    el('div', { class: 'chips' }, data.workspaces.map((w) => el('button', { class: 'ws-chip' + (w.active ? ' on' : ''), onclick: () => api('workspace.switch', { id: w.id }) }, el('span', { text: w.icon }), el('span', { text: w.name }), el('span', { class: 'muted small', text: w.tabs + ' tab' + (w.tabs === 1 ? '' : 's') }))))));
  if (data.recentlyClosed.length) page.append(el('div', { class: 'section' }, el('div', { class: 'label', text: 'Recently closed' }),
    el('div', { class: 'chips' }, data.recentlyClosed.map((c) => el('a', { class: 'ws-chip', href: c.url }, el('span', { text: c.title || c.url }))))));
  root.append(page);
  root.append(el('div', { class: 'corner' }, el('a', { class: 'btn ghost', href: 'wiisb://themes/', text: '🎨 Customise' }), el('a', { class: 'btn ghost', href: 'wiisb://settings/', text: '⚙ Settings' })));

  if (ctx.firstRun) welcome(ctx);
};

// Decorative canvas for the "stars" and "particles" animated themes. It is cheap, pauses when hidden and is off with Reduce Motion.
let fxRaf = 0;
function stopFx() { cancelAnimationFrame(fxRaf); fxRaf = 0; const c = $('#fx'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); }
function startFx(kind) {
  const c = $('#fx'), g = c.getContext('2d');
  const resize = () => { c.width = innerWidth; c.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const n = kind === 'stars' ? 110 : 55;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-secondary') || '#fff';
  const dots = Array.from({ length: n }, () => ({ x: Math.random() * c.width, y: Math.random() * c.height, r: Math.random() * 1.6 + .3, v: Math.random() * .25 + .05, a: Math.random() }));
  let last = 0;
  const frame = (t) => {
    fxRaf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 33) return; // ~30 fps is plenty for a backdrop
    last = t;
    g.clearRect(0, 0, c.width, c.height);
    for (const d of dots) {
      if (kind === 'stars') { d.a += (Math.random() - .5) * .08; d.a = Math.min(1, Math.max(.15, d.a)); g.globalAlpha = d.a; }
      else { d.y -= d.v; d.x += Math.sin((d.y + d.x) / 90) * .15; g.globalAlpha = .55; if (d.y < -5) { d.y = c.height + 5; d.x = Math.random() * c.width; } }
      g.fillStyle = kind === 'stars' ? '#fff' : accent;
      g.beginPath(); g.arc(d.x, d.y, d.r, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;
  };
  fxRaf = requestAnimationFrame(frame);
}

function welcome(ctx) {
  let step = 0;
  const choices = { theme: null, layout: null, engine: null, tracking: 'balanced' };
  const total = 5;
  const finish = async () => { await guard(() => api('welcome.complete')); $('#modal-root').replaceChildren(); };
  const render = async (box, close) => {
    clear(box);
    box.append(el('div', { class: 'steps' }, Array.from({ length: total }, (_, i) => el('i', { class: i <= step ? 'on' : '' }))));
    const next = () => { step++; render(box, close); };
    const skip = el('button', { class: 'btn ghost', text: 'Skip', onclick: () => { finish(); } });
    if (step === 0) {
      box.append(el('div', { class: 'welcome-hero' }, el('img', { src: 'logo.png', alt: '' }), el('h1', { text: 'Welcome to WIISBROWSING' }),
        el('p', { class: 'lead', text: 'Your internet. Reimagined.' }), el('p', { class: 'muted', text: 'A beautiful, powerful browser built around you. A few quick choices, all of them changeable later.' })),
        el('div', { class: 'actions' }, skip, el('button', { class: 'btn', text: 'Start browsing', onclick: finish }), el('button', { class: 'btn accent', text: 'Customise my browser', onclick: next })));
    } else if (step === 1) {
      const list = await api('theme.list');
      box.append(el('h2', { text: 'Pick a look' }), el('div', { class: 'theme-grid' }, list.themes.filter((t) => t.builtIn).map((t) => themeCard(t, list.current === t.id || choices.theme === t.id, async () => { choices.theme = t.id; await guard(() => api('theme.select', { id: t.id })); render(box, close); }))),
        el('div', { class: 'actions' }, skip, el('button', { class: 'btn accent', text: 'Next', onclick: next })));
    } else if (step === 2) {
      const opts = [['vertical-left', 'Vertical tabs (left)', 'Recommended: tabs run down the side, grouped in clusters.'], ['horizontal', 'Tabs on top', 'The classic layout.'], ['compact', 'Compact rail', 'Just icons — the most room for pages.']];
      box.append(el('h2', { text: 'How should tabs look?' }), el('div', { class: 'list' }, opts.map(([v, n, d]) => el('button', { class: 'btn', style: { textAlign: 'left', margin: '4px 0', borderColor: choices.layout === v ? 'var(--accent-primary)' : '' }, onclick: async () => { choices.layout = v; await guard(() => api('settings.set', { key: 'tabs.layout', value: v })); render(box, close); } }, el('b', { text: n }), el('div', { class: 'muted small', text: d })))),
        el('div', { class: 'actions' }, skip, el('button', { class: 'btn accent', text: 'Next', onclick: next })));
    } else if (step === 3) {
      const s = await api('settings.get');
      box.append(el('h2', { text: 'Choose a search engine' }), el('div', { class: 'chips' }, s.searchEngines.map((e) => el('button', { class: 'chip' + ((choices.engine || s.values['search.engine']) === e.id ? ' on' : ''), text: e.name, onclick: async () => { choices.engine = e.id; await guard(() => api('settings.set', { key: 'search.engine', value: e.id })); render(box, close); } }))),
        el('p', { class: 'muted small', text: 'Search suggestions are off by default, so what you type isn\'t sent anywhere until you press Enter. You can turn them on in Settings → Search.' }),
        el('div', { class: 'actions' }, skip, el('button', { class: 'btn accent', text: 'Next', onclick: next })));
    } else {
      box.append(el('h2', { text: 'Privacy' }),
        el('div', { class: 'setting' }, el('div', { class: 'what' }, el('b', { text: 'Block ads and trackers' }), el('div', { text: 'Blocks requests to known ad and tracking hosts. It can\'t catch everything.' })), toggle(true, (v) => api('settings.set', { key: 'privacy.adblock', value: v }))),
        el('div', { class: 'setting' }, el('div', { class: 'what' }, el('b', { text: 'Tracking prevention' }), el('div', { text: 'Uses the engine\'s built-in protection against cross-site tracking.' })),
          (() => { const s = el('select', {}, ...['off', 'balanced', 'strict'].map((v) => el('option', { value: v, text: v[0].toUpperCase() + v.slice(1), selected: v === 'balanced' }))); s.onchange = () => api('settings.set', { key: 'privacy.tracking', value: s.value }); return s; })()),
        el('div', { class: 'actions' }, el('button', { class: 'btn accent', text: 'Start browsing', onclick: finish })));
    }
  };
  modal((box, close) => render(box, close));
}

function themeCard(t, on, onclick) {
  const c = (k) => t.colors[k];
  return el('button', { class: 'theme-card' + (on ? ' on' : ''), onclick, title: t.name },
    el('div', { class: 'mock', style: { background: c('BackgroundPrimary') } }, el('div', { style: { background: c('Sidebar') } }), el('div', { style: { background: c('BackgroundSecondary'), padding: '8px 4px' } }, el('div', { style: { height: '8px', borderRadius: '4px', background: c('TabActive'), marginBottom: '5px' } }), el('div', { style: { height: '8px', borderRadius: '4px', background: c('Tab') } })), el('div', { style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } }, el('div', { style: { height: '10px', borderRadius: '6px', background: c('AddressBar') } }), el('div', { style: { width: '40%', height: '8px', borderRadius: '4px', background: c('AccentPrimary') } }))),
    el('div', { class: 'name', style: { background: c('SurfaceElevated'), color: c('TextPrimary') }, text: t.name }));
}

// ============================ History ============================

WB.pages.history = async function (root, ctx) {
  const state = { range: 'all', text: '', selected: new Set(), entries: [] };
  const list = el('div');
  const search = el('input', { type: 'search', placeholder: 'Search history', 'aria-label': 'Search history', style: { minWidth: '240px' } });
  const del = el('button', { class: 'btn danger', text: 'Delete selected', disabled: true });
  const load = async () => {
    const r = await api('history.query', { text: state.text, range: state.range, limit: 400 });
    state.entries = r.entries; state.selected.clear(); del.disabled = true;
    clear(list);
    if (r.isPrivate) { list.append(el('div', { class: 'empty', text: 'Private windows never record history.' })); return; }
    if (!r.entries.length) { list.append(el('div', { class: 'empty', text: state.text ? 'Nothing matches that search.' : 'No history yet.' })); return; }
    let last = '';
    for (const e of r.entries) {
      const label = dayLabel(e.lastVisit);
      if (label !== last) { list.append(el('div', { class: 'group-title', text: label })); last = label; }
      const box = el('input', { type: 'checkbox', 'aria-label': 'Select', onchange: () => { box.checked ? state.selected.add(e.id) : state.selected.delete(e.id); del.disabled = !state.selected.size; } });
      list.append(el('div', { class: 'item' }, box, favicon(e.host, e.title),
        el('a', { class: 'grow', href: e.url, onclick: (ev) => { if (ctx.panel) { ev.preventDefault(); api('nav.open', { url: e.url, newTab: true }); } } }, el('div', { class: 'title', text: e.title || e.url }), el('div', { class: 'sub', text: e.host })),
        el('span', { class: 'muted small', text: fmtTime(e.lastVisit) })));
    }
  };
  search.oninput = debounce(() => { state.text = search.value; load(); }, 200);
  del.onclick = async () => { await guard(() => api('history.delete', { ids: [...state.selected] })); load(); };
  const ranges = [['all', 'All time'], ['month', 'Last 30 days'], ['week', 'Last 7 days'], ['yesterday', 'Yesterday'], ['today', 'Today']];
  const chips = el('div', { class: 'chips' }, ranges.map(([v, n]) => el('button', { class: 'chip' + (v === state.range ? ' on' : ''), text: n, onclick: (e) => { state.range = v; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); load(); } })));
  const clearMenu = el('select', { 'aria-label': 'Clear history', onchange: async (e) => {
    const v = e.target.value; e.target.value = ''; if (!v) return;
    if (await confirm2('Clear history?', 'This permanently removes the visits from this profile. Bookmarks and downloaded files are kept.', 'Clear')) { await guard(() => api('history.clearRange', { range: v })); load(); toast('History cleared.'); }
  } }, el('option', { value: '', text: 'Clear history…' }), el('option', { value: 'hour', text: 'Last hour' }), el('option', { value: 'today', text: 'Today' }), el('option', { value: 'week', text: 'Last 7 days' }), el('option', { value: 'all', text: 'Everything' }));
  root.append(el('div', { class: 'page' }, el('h1', { text: 'History' }), ctx.panel ? null : el('p', { class: 'lead', text: 'Pages you visited in this profile. Private windows are never recorded.' }),
    el('div', { class: 'toolbar' }, search, clearMenu, del), chips, list));
  load();
};

// ============================ Downloads ============================

WB.pages.downloads = async function (root, ctx) {
  const list = el('div', { class: 'list' });
  let timer = 0;
  const render = async () => {
    const items = await api('downloads.list');
    clear(list);
    if (!items.length) { list.append(el('div', { class: 'empty', text: 'Files you download will appear here.' })); return; }
    for (const d of items) {
      const active = d.state === 'in_progress' || d.state === 'paused';
      const frac = d.total > 0 ? d.received / d.total : -1;
      const stateText = { completed: fmtBytes(d.total || d.received), failed: 'Download failed', cancelled: 'Cancelled', paused: 'Paused — ' + fmtBytes(d.received), in_progress: fmtBytes(d.received) + (d.total ? ' of ' + fmtBytes(d.total) : '') + (d.speed > 1 ? ' · ' + fmtBytes(d.speed) + '/s' : '') }[d.state] || d.state;
      const acts = el('div', { class: 'row' });
      if (d.state === 'in_progress') acts.append(el('button', { class: 'btn icon', text: '⏸', title: 'Pause', onclick: () => api('downloads.pause', { id: d.id }) }));
      if (d.state === 'paused') acts.append(el('button', { class: 'btn icon', text: '▶', title: 'Resume', onclick: () => api('downloads.resume', { id: d.id }) }));
      if (active) acts.append(el('button', { class: 'btn icon', text: '✕', title: 'Cancel', onclick: () => api('downloads.cancel', { id: d.id }) }));
      if (d.state === 'completed' && d.exists) acts.append(el('button', { class: 'btn', text: 'Open', onclick: () => guard(() => api('downloads.open', { id: d.id })) }), el('button', { class: 'btn', text: 'Show in folder', onclick: () => api('downloads.folder', { id: d.id }) }));
      if (d.state === 'completed' && !d.exists) acts.append(el('span', { class: 'muted small', text: 'File moved or deleted' }));
      if (d.state === 'failed' || d.state === 'cancelled') acts.append(el('button', { class: 'btn', text: 'Retry', onclick: () => api('nav.open', { url: d.url, newTab: true }) }));
      if (!active) acts.append(el('button', { class: 'btn ghost icon', text: '🗑', title: 'Remove from list', onclick: async () => { await api('downloads.remove', { id: d.id }); render(); } }));
      list.append(el('div', { class: 'item' }, favicon(d.host, d.fileName),
        el('div', { class: 'grow' }, el('div', { class: 'title', text: d.fileName }), el('div', { class: 'sub', text: d.url }),
          active ? el('div', { class: 'progress' + (frac < 0 ? ' indeterminate' : '') }, el('div', { style: { width: Math.max(0, frac) * 100 + '%' } })) : null,
          el('div', { class: 'sub', text: stateText }), d.risky && d.state === 'completed' ? el('div', { class: 'small', style: { color: '#fbbf24' }, text: 'This type of file can run code. Open it only if you trust the website.' }) : null),
        acts));
    }
    clearTimeout(timer);
    if (items.some((i) => i.state === 'in_progress' || i.state === 'paused')) timer = setTimeout(render, 1000);
  };
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Downloads' }), ctx.panel ? null : el('p', { class: 'lead', text: 'Progress, speed and results come straight from the browser engine. Downloads never open on their own.' }),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', text: 'Clear finished', onclick: async () => { await api('downloads.clear'); render(); } }),
      el('button', { class: 'btn', text: 'Change download folder', onclick: async () => { const f = await guard(() => api('downloads.pickFolder')); if (f) toast('Downloads now save to ' + f); } })), list));
  render();
};

// ============================ Bookmarks ============================

WB.pages.bookmarks = async function (root, ctx) {
  const st = { folder: null, text: '', sort: 'manual', selected: new Set(), tree: null };
  const side = el('div', { class: 'list', style: { minWidth: '190px' } });
  const main = el('div');
  const search = el('input', { type: 'search', placeholder: 'Search bookmarks', 'aria-label': 'Search bookmarks' });
  const bar = el('div', { class: 'toolbar' });

  const load = async () => { st.tree = await api('bookmarks.tree'); st.selected.clear(); draw(); };
  const folderName = (id) => id === null ? 'Bookmarks' : (st.tree.folders.find((f) => f.id === id) || {}).name || 'Folder';
  const childrenOf = (pid) => st.tree.folders.filter((f) => f.parentId === pid);
  const drawFolders = (pid, depth) => {
    for (const f of childrenOf(pid)) {
      side.append(el('div', { class: 'item', style: { paddingLeft: 12 + depth * 14 + 'px', background: st.folder === f.id ? 'var(--tab-active)' : '' }, onclick: () => { st.folder = f.id; draw(); }, oncontextmenu: (e) => { e.preventDefault(); folderMenu(f); } }, el('span', { text: '📁' }), el('span', { class: 'title grow', text: f.name })));
      drawFolders(f.id, depth + 1);
    }
  };
  const folderMenu = (f) => modal((box, close) => {
    box.append(el('h2', { text: f.name }),
      el('div', { class: 'actions', style: { justifyContent: 'flex-start' } },
        el('button', { class: 'btn', text: 'Rename', onclick: async () => { close(); const r = await prompt2('Rename folder', [{ key: 'name', label: 'Name', value: f.name }]); if (r) { await guard(() => api('bookmarks.renameFolder', { id: f.id, name: r.name })); load(); } } }),
        el('button', { class: 'btn danger', text: 'Delete folder and its bookmarks', onclick: async () => { close(); if (await confirm2('Delete folder?', 'The folder and everything inside it will be removed.', 'Delete')) { await guard(() => api('bookmarks.removeFolder', { id: f.id })); if (st.folder === f.id) st.folder = null; load(); } } })));
  });
  const draw = () => {
    clear(side); clear(main); clear(bar);
    side.append(el('div', { class: 'item', style: { background: st.folder === null ? 'var(--tab-active)' : '' }, onclick: () => { st.folder = null; draw(); } }, el('span', { text: '⭐' }), el('span', { class: 'title grow', text: 'All bookmarks' })));
    drawFolders(null, 0);
    let items = st.tree.bookmarks.filter((b) => st.text ? (b.title + ' ' + b.url).toLowerCase().includes(st.text.toLowerCase()) : (st.folder === null ? !b.folderId || true : b.folderId === st.folder));
    if (st.folder === null && !st.text) items = st.tree.bookmarks.filter((b) => !b.folderId);
    if (st.sort === 'name') items = [...items].sort((a, b) => a.title.localeCompare(b.title)); else if (st.sort === 'date') items = [...items].sort((a, b) => b.createdAt - a.createdAt);
    const sel = el('select', { 'aria-label': 'Sort', onchange: (e) => { st.sort = e.target.value; draw(); } }, ...[['manual', 'Sort: saved order'], ['name', 'Sort: name'], ['date', 'Sort: newest']].map(([v, n]) => el('option', { value: v, text: n, selected: st.sort === v })));
    const moveTo = el('select', { 'aria-label': 'Move selected', disabled: !st.selected.size, onchange: async (e) => { const v = e.target.value; e.target.value = ''; if (v === '') return; await guard(() => api('bookmarks.move', { ids: [...st.selected], folderId: v === 'root' ? null : parseInt(v, 10) })); load(); } },
      el('option', { value: '', text: 'Move selected to…' }), el('option', { value: 'root', text: 'Bookmarks (top level)' }), ...st.tree.folders.map((f) => el('option', { value: f.id, text: f.name })));
    bar.append(search, sel, moveTo,
      el('button', { class: 'btn', text: 'New folder', onclick: async () => { const r = await prompt2('New folder', [{ key: 'name', label: 'Name' }], 'Create'); if (r) { await guard(() => api('bookmarks.addFolder', { name: r.name, parentId: st.folder })); load(); } } }),
      el('button', { class: 'btn danger', text: 'Delete selected', disabled: !st.selected.size, onclick: async () => { await guard(() => api('bookmarks.remove', { ids: [...st.selected] })); load(); } }));
    if (!ctx.panel) bar.append(el('span', { class: 'right row' },
      el('button', { class: 'btn', text: 'Import…', onclick: async () => { const r = await guard(() => api('bookmarks.import')); if (r) { toast(`Imported ${r.added} bookmarks (${r.skipped} skipped).`); load(); } } }),
      el('button', { class: 'btn', text: 'Export…', onclick: async () => { if (await guard(() => api('bookmarks.export'))) toast('Bookmarks exported.'); } })));
    main.append(el('div', { class: 'group-title', text: st.text ? 'Results' : folderName(st.folder) }));
    if (!items.length) main.append(el('div', { class: 'empty', text: st.text ? 'No bookmarks match.' : 'Nothing here yet. Press Ctrl+D on a page to bookmark it.' }));
    for (const b of items) {
      const cb = el('input', { type: 'checkbox', checked: st.selected.has(b.id), 'aria-label': 'Select', onchange: () => { cb.checked ? st.selected.add(b.id) : st.selected.delete(b.id); draw(); } });
      main.append(el('div', { class: 'item' }, cb, favicon(b.host, b.title),
        el('a', { class: 'grow', href: b.url, onclick: (ev) => { if (ctx.panel) { ev.preventDefault(); api('nav.open', { url: b.url, newTab: true }); } } }, el('div', { class: 'title', text: b.title }), el('div', { class: 'sub', text: b.url })),
        el('button', { class: 'btn ghost icon', text: '✎', title: 'Edit', onclick: async () => { const r = await prompt2('Edit bookmark', [{ key: 'title', label: 'Name', value: b.title }, { key: 'url', label: 'Address', value: b.url }]); if (r) { await guard(() => api('bookmarks.update', { id: b.id, title: r.title, url: r.url, folderId: b.folderId })); load(); } } })));
    }
  };
  search.oninput = debounce(() => { st.text = search.value; draw(); }, 150);
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Bookmarks' }), bar,
    ctx.panel ? main : el('div', { style: { display: 'grid', gridTemplateColumns: '220px 1fr', gap: '20px' } }, el('div', { class: 'card' }, side), main)));
  if (ctx.panel) root.firstChild.prepend();
  await load();
};

// ============================ Notes ============================

function renderMarkdown(text) {
  // Minimal, safe Markdown: headings, bullets, bold/italic/code, http(s) links. Built with DOM calls only.
  const out = el('div');
  const inline = (s) => {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) frag.append(el('b', { text: t.slice(2, -2) }));
      else if (t.startsWith('`')) frag.append(el('code', { text: t.slice(1, -1) }));
      else if (t.startsWith('[')) { const p = t.indexOf(']('); frag.append(el('a', { href: t.slice(p + 2, -1), text: t.slice(1, p), target: '_blank', rel: 'noopener noreferrer' })); }
      else frag.append(el('i', { text: t.slice(1, -1) }));
      last = m.index + t.length;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  };
  for (const line of text.split('\n')) {
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) out.append(el('h' + (h[1].length + 1), {}, inline(h[2])));
    else if (/^\s*[-*]\s+/.test(line)) out.append(el('div', { style: { paddingLeft: '14px' } }, '• ', inline(line.replace(/^\s*[-*]\s+/, ''))));
    else if (line.trim()) out.append(el('p', { style: { margin: '4px 0' } }, inline(line)));
  }
  return out;
}

WB.pages.notes = async function (root, ctx) {
  const st = { notes: [], sel: null, search: '', preview: false };
  const list = el('div', { class: 'list' });
  const editor = el('div');
  const search = el('input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' });
  const load = async (keep) => { st.notes = await api('notes.list', { search: st.search }); if (keep) st.sel = st.notes.find((n) => n.id === keep) || null; draw(); };
  const draw = () => {
    clear(list); clear(editor);
    for (const n of st.notes) list.append(el('div', { class: 'item', style: { background: st.sel && st.sel.id === n.id ? 'var(--tab-active)' : '' }, onclick: () => { st.sel = n; draw(); } },
      el('span', { text: n.pinned ? '📌' : '📝' }), el('div', { class: 'grow' }, el('div', { class: 'title', text: n.title || 'Untitled' }), el('div', { class: 'sub', text: (n.body || '').slice(0, 70) }))));
    if (!st.notes.length) list.append(el('div', { class: 'empty', text: st.search ? 'No notes match.' : 'No notes yet.' }));
    if (!st.sel) { editor.append(el('div', { class: 'empty', text: 'Select a note, or create one.' })); return; }
    const n = st.sel;
    const title = el('input', { type: 'text', value: n.title, placeholder: 'Title', style: { width: '100%', fontSize: '17px' } });
    const body = el('textarea', { value: n.body, placeholder: 'Write something… (Markdown works: # heading, - bullet, **bold**)', style: { minHeight: ctx.panel ? '220px' : '320px' } });
    const save = debounce(async () => { n.title = title.value; n.body = body.value; await guard(() => api('notes.update', { id: n.id, title: n.title, body: n.body, pinned: n.pinned })); }, 500);
    title.oninput = save; body.oninput = save;
    const preview = el('div', { class: 'card hidden' });
    editor.append(title, el('div', { style: { height: '8px' } }), body, preview, el('div', { class: 'toolbar', style: { marginTop: '10px' } },
      el('button', { class: 'btn', text: 'Preview', onclick: () => { preview.classList.toggle('hidden'); body.classList.toggle('hidden'); clear(preview).append(renderMarkdown(body.value)); } }),
      el('button', { class: 'btn', text: n.pinned ? 'Unpin' : 'Pin', onclick: async () => { n.pinned = !n.pinned; await guard(() => api('notes.update', { id: n.id, title: title.value, body: body.value, pinned: n.pinned })); load(n.id); } }),
      el('button', { class: 'btn', text: 'Export…', onclick: () => guard(() => api('notes.export', { id: n.id })) }),
      el('button', { class: 'btn danger', text: 'Delete', onclick: async () => { if (await confirm2('Delete this note?', 'This can\'t be undone.', 'Delete')) { await guard(() => api('notes.remove', { id: n.id })); st.sel = null; load(); } } })),
      n.url ? el('div', { class: 'muted small' }, 'Attached to ', el('a', { href: n.url, text: n.url })) : null);
  };
  search.oninput = debounce(() => { st.search = search.value; load(); }, 200);
  root.append(el('div', { class: 'page' }, el('h1', { text: 'Notes' }),
    el('div', { class: 'toolbar' }, search,
      el('button', { class: 'btn accent', text: 'New note', onclick: async () => { const r = await guard(() => api('notes.add', { title: '', body: '' })); if (r) { await load(r.id); } } }),
      el('button', { class: 'btn', text: 'New note about this page', title: 'Attaches the address of the page you were on', onclick: async () => { const r = await guard(() => api('notes.add', { title: 'Note', body: '', attachPage: true })); if (r) await load(r.id); } })),
    ctx.panel ? el('div', {}, el('div', { class: 'card', style: { marginBottom: '12px', maxHeight: '170px', overflow: 'auto' } }, list), editor)
      : el('div', { style: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '20px' } }, el('div', { class: 'card' }, list), el('div', {}, editor))));
  await load();
};

// ============================ Reader ============================

WB.pages.reader = async function (root, ctx) {
  let a;
  try { a = await api('reader.get'); } catch (e) { root.append(el('div', { class: 'page' }, el('h1', { text: 'Reader mode' }), el('p', { class: 'muted', text: e.message }))); return; }
  document.title = a.title + ' — Reader';
  const body = el('article');
  const text = [];
  for (const b of a.blocks) {
    if (b.t === 'h') body.append(el('h' + Math.min(4, b.l + 1), { text: b.x }));
    else if (b.t === 'p') { body.append(el('p', { text: b.x })); text.push(b.x); }
    else if (b.t === 'quote') body.append(el('blockquote', { text: b.x }));
    else if (b.t === 'pre') body.append(el('pre', { text: b.x }));
    else if (b.t === 'ul' || b.t === 'ol') body.append(el(b.t, {}, (b.items || []).map((i) => el('li', { text: i }))));
    else if (b.t === 'img' && b.src) body.append(el('img', { src: b.src, alt: b.alt || '', referrerpolicy: 'no-referrer', loading: 'lazy' }));
  }
  const apply = (k, v) => { document.documentElement.style.setProperty(k, v); localStorage.setItem('wiisb.' + k, v); };
  let size = parseInt(localStorage.getItem('wiisb.--rsize') || '19', 10), line = parseFloat(localStorage.getItem('wiisb.--rline') || '1.7');
  apply('--rsize', size + 'px'); apply('--rline', String(line));
  const setTheme = (t) => { document.body.classList.remove('reader-light', 'reader-sepia'); if (t) document.body.classList.add('reader-' + t); localStorage.setItem('wiisb.readerTheme', t || ''); };
  setTheme(localStorage.getItem('wiisb.readerTheme') || '');
  const tools = el('div', { class: 'reader-tools' },
    el('button', { class: 'btn', text: 'A−', onclick: () => { size = Math.max(14, size - 1); apply('--rsize', size + 'px'); } }), el('button', { class: 'btn', text: 'A+', onclick: () => { size = Math.min(32, size + 1); apply('--rsize', size + 'px'); } }),
    el('button', { class: 'btn', text: 'Line spacing', onclick: () => { line = line >= 2 ? 1.4 : line + 0.2; apply('--rline', line.toFixed(1)); } }),
    el('button', { class: 'btn', text: 'Dark', onclick: () => setTheme('') }), el('button', { class: 'btn', text: 'Light', onclick: () => setTheme('light') }), el('button', { class: 'btn', text: 'Sepia', onclick: () => setTheme('sepia') }),
    el('button', { class: 'btn', text: '🔊 Read aloud', onclick: () => api('speech.speak', { text: text.join('\n\n').slice(0, 40000) }) }), el('button', { class: 'btn', text: 'Stop', onclick: () => api('speech.stop') }),
    el('button', { class: 'btn', text: 'Print', onclick: () => window.print() }),
    el('span', { class: 'right muted small', text: Math.max(1, Math.round(a.words / 230)) + ' min read' }));
  root.append(tools, el('div', { class: 'reader' }, el('h1', { text: a.title }), el('div', { class: 'muted small', style: { marginBottom: '18px' } }, [a.byline, a.site].filter(Boolean).join(' · '), ' · ', el('a', { href: a.sourceUrl, text: 'Original page' })), body));
};
