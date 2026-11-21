'use strict';
(async function boot() {
  const root = $('#app');
  try {
    const ctx = await api('init');
    WB.ctx = ctx;
    applyTheme({ vars: ctx.theme, dark: ctx.dark, animated: ctx.animated, themeId: ctx.themeId });
    if (ctx.panel) document.body.classList.add('panel');
    const page = WB.pages[ctx.page];
    if (!page) { root.append(el('div', { class: 'page' }, el('h1', { text: 'Page not found' }))); return; }
    document.title = ({ newtab: 'New tab', settings: 'Settings', history: 'History', downloads: 'Downloads', bookmarks: 'Bookmarks', themes: 'Themes', performance: 'WIISB Control', profiles: 'Profiles', extensions: 'Extensions', about: 'About', help: 'Help', notes: 'Notes', reader: 'Reader', privacy: 'Privacy', tools: 'Mini tools', error: 'Error' })[ctx.page] || 'WIISBROWSING';
    await page(root, ctx);
  } catch (e) {
    clear(root).append(el('div', { class: 'page' }, el('h1', { text: 'Something went wrong' }), el('p', { class: 'muted', text: e.message })));
  }
})();
