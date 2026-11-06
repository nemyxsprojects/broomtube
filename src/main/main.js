const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, dialog, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const adblock = require('./adblock');
const downloader = require('./downloader');
const netfilter = require('./netfilter');
const features = require('./features');
const i18n = require('./i18n');
const signin = require('./signin');

let t = i18n.translator('en');

app.setAppUserModelId('com.broomtube.app');
// Reprise des données d'une installation précédente (connexion, réglages, onglets)
try {
  const newDir = app.getPath('userData');
  if (!fs.existsSync(newDir)) {
    const old = ['Vacuum Desktop', 'ReTube', 'BetterYoutube Desktop'].map((n) => path.join(app.getPath('appData'), n)).find((d) => fs.existsSync(d));
    if (old) fs.renameSync(old, newDir);
  }
} catch (e) { console.warn('Migration des données impossible', e.message); }
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

nativeTheme.themeSource = 'dark';

const HOME = { youtube: 'https://www.youtube.com/', music: 'https://music.youtube.com/' };
const PARTITION = 'persist:betteryoutube';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const SHIELD_SRC = fs.readFileSync(path.join(__dirname, '..', 'preload', 'adshield.js'), 'utf8');
const ADBLOCK_CSS = fs.readFileSync(path.join(__dirname, '..', 'preload', 'adblock.css'), 'utf8');
const FEATURES_CSS = fs.readFileSync(path.join(__dirname, '..', 'preload', 'features.css'), 'utf8');

// Réglages SponsorBlock / Return YouTube Dislike transmis aux pages
function featuresConfig() {
  const s = settings.get();
  return {
    sb: { enabled: !!s.sbEnabled, categories: s.sbCategories, markers: !!s.sbShowMarkers, notify: !!s.sbNotify, minDuration: +s.sbMinDuration || 0, countViews: !!s.sbCountViews },
    ryd: { enabled: !!s.rydEnabled, bar: !!s.rydShowBar, compact: !!s.rydCompact },
    strings: Object.fromEntries(Object.entries(i18n.strings(s.language)).filter(([k]) => k.startsWith('sb.'))),
  };
}

let win = null;
let ses = null;
let chromeUA = '';
let contentBounds = { x: 0, y: 0, width: 800, height: 600 };
let currentSection = 'youtube';
let fullscreenTab = null;
let nextTabId = 1;
const sections = { youtube: { tabs: [], activeId: null }, music: { tabs: [], activeId: null } };
const tabsById = new Map();

// ---------------------------------------------------------------- utilitaires URL
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }
const isYouTubeHost = (h) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(h);
const isGoogleHost = (h) => /(^|\.)google\.[a-z.]+$|(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/.test(h);
const isInternal = (u) => { const h = hostOf(u); return u.startsWith('about:') || isYouTubeHost(h) || isGoogleHost(h); };
const sectionForUrl = (u) => (hostOf(u) === 'music.youtube.com' ? 'music' : 'youtube');
function isContentPage(u) {
  // Pages "contenu" de www.youtube.com (pas les pages de connexion)
  try {
    const x = new URL(u);
    if (!/^(www\.|m\.)?youtube\.com$/.test(x.hostname) && x.hostname !== 'youtu.be') return false;
    return x.hostname === 'youtu.be' || /^\/($|watch|shorts|results|feed|channel|c\/|@|playlist|live|embed)/.test(x.pathname);
  } catch { return false; }
}
function unwrapRedirect(u) {
  try {
    const x = new URL(u);
    if (isYouTubeHost(x.hostname) && x.pathname === '/redirect' && x.searchParams.get('q')) return x.searchParams.get('q');
    if (isGoogleHost(x.hostname) && x.pathname === '/url' && x.searchParams.get('q')) return x.searchParams.get('q');
  } catch {}
  return u;
}
// Google sign-in pages are opened in the dedicated sign-in window
function isGoogleSignin(u) {
  try {
    const x = new URL(u);
    return x.hostname === 'accounts.google.com' && /^\/(ServiceLogin|InteractiveLogin|AccountChooser|signin|v3\/signin)/i.test(x.pathname);
  } catch { return false; }
}
function signedIn() {
  for (const t of tabsById.values()) t.view.webContents.reload();
  send('account:changed', null);
}
// Sign-in in the dedicated window. If Google refuses it, offer to try again.
function startSignin(url) {
  signin.openSigninWindow({
    parent: win, partition: PARTITION, url,
    onDone: signedIn,
    onRejected: async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: [t('dialog.retry'), t('dialog.cancel')], defaultId: 0, cancelId: 1,
        title: t('dialog.rejected.title'), message: t('dialog.rejected.message'), detail: t('dialog.rejected.detail'),
      });
      if (r.response === 0) startSignin(url);
    },
  });
}
function openExternal(u) {
  const t = unwrapRedirect(u);
  if (/^https?:\/\//i.test(t)) shell.openExternal(t);
}
function normalizeInput(input, section) {
  const s = (input || '').trim();
  if (!s) return HOME[section];
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !/\s/.test(s)) return 'https://' + s;
  return section === 'music'
    ? `https://music.youtube.com/search?q=${encodeURIComponent(s)}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(s)}`;
}
const isVideoUrl = (u) => {
  try {
    const x = new URL(u);
    if (x.hostname === 'youtu.be') return true;
    if (!isYouTubeHost(x.hostname)) return false;
    return (x.pathname === '/watch' && x.searchParams.has('v')) || x.pathname.startsWith('/shorts/') ||
      x.pathname === '/playlist' || x.pathname.startsWith('/live/') || x.searchParams.has('list');
  } catch { return false; }
};

// ---------------------------------------------------------------- état envoyé à l'interface
const tr = (k, v) => t(k, v);
function tabInfo(t) {
  const wc = t.view.webContents;
  return {
    id: t.id, section: t.section, title: t.title || tr('tab.loading'), url: t.url, favicon: t.favicon,
    loading: t.loading, audible: t.audible, muted: wc.isAudioMuted(),
    canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
    isVideo: isVideoUrl(t.url),
  };
}
function state() {
  return {
    section: currentSection,
    sections: {
      youtube: { activeId: sections.youtube.activeId, tabs: sections.youtube.tabs.map(tabInfo) },
      music: { activeId: sections.music.activeId, tabs: sections.music.tabs.map(tabInfo) },
    },
    downloadsActive: downloader.activeCount(),
  };
}
let stateTimer = null;
function pushState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('ui:state', state());
    persistTabs();
  }, 30);
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function persistTabs() {
  const saved = {};
  for (const s of ['youtube', 'music']) {
    const sec = sections[s];
    saved[s] = { urls: sec.tabs.map((t) => t.url).filter(Boolean), active: Math.max(0, sec.tabs.findIndex((t) => t.id === sec.activeId)) };
  }
  settings.update({ savedTabs: saved, lastSection: currentSection === 'settings' ? settings.get('lastSection') : currentSection });
}

// ---------------------------------------------------------------- onglets
function createTab(section, url, { activate = true } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, '..', 'preload', 'view-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // la musique continue quand on change de section / d'onglet
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#0f0f0f');
  view.setVisible(false);
  view.setBounds(contentBounds); // les onglets en arrière-plan gardent une taille correcte
  const tab = { id: nextTabId++, section, view, title: '', url: url || HOME[section], favicon: '', loading: true, audible: false };
  tabsById.set(tab.id, tab);
  sections[section].tabs.push(tab);
  win.contentView.addChildView(view);
  wireTab(tab);
  view.webContents.loadURL(tab.url).catch(() => {});
  if (activate) activateTab(tab.id);
  else pushState();
  return tab;
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  wc.setUserAgent(chromeUA);
  netfilter.attach(wc);

  wc.on('page-title-updated', (_e, title) => { tab.title = title; pushState(); });
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || ''; pushState(); });
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });
  wc.on('did-navigate', (_e, url) => { tab.url = url; pushState(); });
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { tab.url = url; pushState(); } });
  wc.on('audio-state-changed', (e) => { tab.audible = e.audible; pushState(); });
  wc.on('dom-ready', () => {
    if (!isYouTubeHost(hostOf(wc.getURL()))) return;
    if (settings.get('adblockEnabled')) wc.insertCSS(ADBLOCK_CSS).catch(() => {});
    wc.insertCSS(FEATURES_CSS).catch(() => {});
  });

  // Connexion Google : se présenter comme Firefox (Google refuse les navigateurs "intégrés")
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const want = hostOf(details.url) === 'accounts.google.com' ? FIREFOX_UA : chromeUA;
    if (wc.getUserAgent() !== want) wc.setUserAgent(want);
  });

  wc.on('will-navigate', (e) => {
    const url = e.url;
    if (isGoogleSignin(url)) { e.preventDefault(); startSignin(url); return; }
    if (!isInternal(url)) { e.preventDefault(); openExternal(url); return; }
    const target = sectionForUrl(url);
    if (target !== tab.section && (target === 'music' || isContentPage(url))) {
      e.preventDefault();
      createTab(target, url);
      switchSection(target);
    }
  });

  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (isGoogleSignin(url)) { startSignin(url); return { action: 'deny' }; }
    const real = unwrapRedirect(url);
    if (isInternal(real) && real === url) {
      const target = sectionForUrl(url);
      createTab(target, url, { activate: disposition !== 'background-tab' });
      if (target !== currentSection && disposition !== 'background-tab') switchSection(target);
    } else {
      openExternal(real);
    }
    return { action: 'deny' };
  });

  wc.on('enter-html-full-screen', () => { fullscreenTab = tab; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { fullscreenTab = null; win.setFullScreen(false); layout(); });

  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });

  wc.on('context-menu', (_e, p) => showContextMenu(tab, p));

  wc.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') { tab.title = t('tab.crashed'); pushState(); setTimeout(() => !wc.isDestroyed() && wc.reload(), 800); }
  });
}

function activeTab(section = currentSection) {
  const sec = sections[section];
  return sec ? tabsById.get(sec.activeId) : null;
}

function activateTab(id) {
  const tab = tabsById.get(id);
  if (!tab) return;
  sections[tab.section].activeId = id;
  if (currentSection !== tab.section) currentSection = tab.section;
  layout();
  if (win.isFocused()) tab.view.webContents.focus();
  pushState();
}

function closeTab(id) {
  const tab = tabsById.get(id);
  if (!tab) return;
  const sec = sections[tab.section];
  const idx = sec.tabs.indexOf(tab);
  sec.tabs.splice(idx, 1);
  tabsById.delete(id);
  if (fullscreenTab === tab) { fullscreenTab = null; win.setFullScreen(false); }
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (sec.activeId === id) {
    const next = sec.tabs[idx] || sec.tabs[idx - 1];
    sec.activeId = next ? next.id : null;
  }
  // Une section n'est jamais vide : un nouvel onglet d'accueil est créé
  if (sec.tabs.length === 0) createTab(tab.section, HOME[tab.section], { activate: currentSection === tab.section });
  else { layout(); pushState(); }
}

function switchSection(s) {
  if (!['youtube', 'music', 'settings'].includes(s)) return;
  currentSection = s;
  if (s !== 'settings' && sections[s].tabs.length === 0) createTab(s, HOME[s]);
  layout();
  const t = activeTab();
  if (t) t.view.webContents.focus();
  pushState();
}

function layout() {
  if (!win) return;
  const shown = currentSection === 'settings' ? null : activeTab();
  for (const t of tabsById.values()) {
    const visible = fullscreenTab ? t === fullscreenTab : t === shown;
    if (t === fullscreenTab) {
      const [w, h] = win.getContentSize();
      t.view.setBounds({ x: 0, y: 0, width: w, height: h });
    } else {
      t.view.setBounds(contentBounds);
    }
    t.view.setVisible(visible);
  }
}

// ---------------------------------------------------------------- navigation / raccourcis
function nav(action, tab = activeTab()) {
  if (!tab) return;
  const wc = tab.view.webContents;
  switch (action) {
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'hard-reload': wc.reloadIgnoringCache(); break;
    case 'stop': wc.stop(); break;
    case 'home': wc.loadURL(HOME[tab.section]); break;
    case 'mute': wc.setAudioMuted(!wc.isAudioMuted()); pushState(); break;
    case 'zoom-in': wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5)); break;
    case 'zoom-out': wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5)); break;
    case 'zoom-reset': wc.setZoomLevel(0); break;
    case 'devtools': wc.toggleDevTools(); break;
  }
}

function cycleTab(dir) {
  if (currentSection === 'settings') return;
  const sec = sections[currentSection];
  if (sec.tabs.length < 2) return;
  const i = sec.tabs.findIndex((t) => t.id === sec.activeId);
  activateTab(sec.tabs[(i + dir + sec.tabs.length) % sec.tabs.length].id);
}

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const k = input.key.toLowerCase();
  const ctrl = input.control || input.meta;
  const sec = currentSection === 'settings' ? settings.get('lastSection') || 'youtube' : currentSection;
  if (ctrl && k === 't') { switchSection(sec); createTab(sec); return true; }
  if (ctrl && k === 'w') { const t = activeTab(); if (t && currentSection !== 'settings') closeTab(t.id); return true; }
  if (ctrl && k === 'tab') { cycleTab(input.shift ? -1 : 1); return true; }
  if (ctrl && k === 'pagedown') { cycleTab(1); return true; }
  if (ctrl && k === 'pageup') { cycleTab(-1); return true; }
  if (ctrl && /^[1-9]$/.test(k) && currentSection !== 'settings') {
    const tabs = sections[currentSection].tabs; const t = k === '9' ? tabs[tabs.length - 1] : tabs[+k - 1];
    if (t) activateTab(t.id); return true;
  }
  if (ctrl && k === 'r' || k === 'f5') { nav(input.shift || ctrl && k === 'f5' ? 'hard-reload' : 'reload'); return true; }
  if (input.alt && k === 'arrowleft') { nav('back'); return true; }
  if (input.alt && k === 'arrowright') { nav('forward'); return true; }
  if (input.alt && k === 'home') { nav('home'); return true; }
  if (ctrl && (k === 'l' || k === 'k' && input.shift)) { send('ui:command', 'focus-address'); win.webContents.focus(); return true; }
  if (ctrl && k === 'd') { send('ui:command', 'download-current'); return true; }
  if (ctrl && k === 'j') { send('ui:command', 'toggle-downloads'); return true; }
  if (ctrl && (k === '=' || k === '+')) { nav('zoom-in'); return true; }
  if (ctrl && k === '-') { nav('zoom-out'); return true; }
  if (ctrl && k === '0') { nav('zoom-reset'); return true; }
  if (ctrl && k === ',') { switchSection('settings'); return true; }
  if (ctrl && input.shift && k === 'i' || k === 'f12') { nav('devtools'); return true; }
  if (k === 'f11') { if (!fullscreenTab) win.setFullScreen(!win.isFullScreen()); return true; }
  return false;
}

function showContextMenu(tab, p) {
  const wc = tab.view.webContents;
  const link = p.linkURL ? unwrapRedirect(p.linkURL) : '';
  const items = [];
  if (link) {
    if (isInternal(link)) {
      items.push({ label: t('menu.newTab'), click: () => createTab(sectionForUrl(link), link, { activate: false }) });
    } else {
      items.push({ label: t('menu.external'), click: () => openExternal(link) });
    }
    if (isVideoUrl(link)) {
      items.push({ label: t('menu.dlVideo'), click: () => send('ui:command', { type: 'download', url: link, title: p.linkText || link, kind: 'video' }) });
      items.push({ label: t('menu.dlAudio'), click: () => send('ui:command', { type: 'download', url: link, title: p.linkText || link, kind: 'audio' }) });
    }
    items.push({ label: t('menu.copyLink'), click: () => clipboard.writeText(link) }, { type: 'separator' });
  }
  if (p.selectionText) items.push({ label: t('menu.copy'), role: 'copy' }, { type: 'separator' });
  if (p.isEditable) items.push({ label: t('menu.cut'), role: 'cut' }, { label: t('menu.copy'), role: 'copy' }, { label: t('menu.paste'), role: 'paste' }, { type: 'separator' });
  items.push(
    { label: t('menu.back'), enabled: wc.navigationHistory.canGoBack(), click: () => nav('back', tab) },
    { label: t('menu.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => nav('forward', tab) },
    { label: t('menu.reload'), click: () => nav('reload', tab) },
    { type: 'separator' },
    { label: t('menu.copyAddress'), click: () => clipboard.writeText(tab.url) },
  );
  if (isVideoUrl(tab.url)) items.push({ label: t('menu.dlPage'), click: () => send('ui:command', 'download-current') });
  items.push({ type: 'separator' }, { label: t('menu.inspect'), click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  // Configuration demandée de façon synchrone par le preload des onglets
  ipcMain.on('broom:view-config', (e, href) => {
    const h = hostOf(href);
    e.returnValue = {
      adblock: !!settings.get('adblockEnabled') && isYouTubeHost(h), shield: SHIELD_SRC,
      youtube: isYouTubeHost(h), ...featuresConfig(),
    };
  });
  // SponsorBlock / Return YouTube Dislike (requêtes faites ici : pas de CORS ni de CSP côté page)
  ipcMain.handle('sb:segments', (_e, videoId) => {
    const cats = Object.entries(settings.get('sbCategories') || {}).filter(([, mode]) => mode !== 'off').map(([c]) => c);
    return settings.get('sbEnabled') ? features.sponsorSegments(videoId, cats) : [];
  });
  ipcMain.on('sb:viewed', (_e, uuid) => { if (settings.get('sbCountViews')) features.sponsorViewed(uuid); });
  ipcMain.handle('ryd:votes', (_e, videoId) => (settings.get('rydEnabled') ? features.dislikes(videoId) : null));
  ipcMain.handle('vdh:status', () => features.vdhStatus());
  ipcMain.handle('account:status', async () => ({ signedIn: await signin.isSignedIn(ses) }));
  ipcMain.on('account:signin', () => startSignin());
  ipcMain.handle('account:signout', async () => {
    await signin.signOut(ses);
    for (const t of tabsById.values()) t.view.webContents.reload();
    return true;
  });
  ipcMain.handle('vdh:open', (_e, url) => features.openInFirefox(url));
  ipcMain.on('broom:nav', (e, action) => {
    const tab = [...tabsById.values()].find((t) => t.view.webContents === e.sender);
    if (tab) nav(action, tab);
  });

  ipcMain.handle('ui:state', () => state());
  ipcMain.handle('i18n:get', () => {
    const lang = i18n.normalize(settings.get('language'));
    return { lang, languages: i18n.LANGUAGES, strings: i18n.strings(lang) };
  });
  ipcMain.on('ui:bounds', (_e, b) => {
    contentBounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) };
    layout();
  });
  ipcMain.on('ui:switch-section', (_e, s) => switchSection(s));
  ipcMain.on('ui:new-tab', (_e, s, url) => { const sec = s || (currentSection === 'settings' ? 'youtube' : currentSection); switchSection(sec); createTab(sec, url ? normalizeInput(url, sec) : HOME[sec]); });
  ipcMain.on('ui:activate-tab', (_e, id) => activateTab(id));
  ipcMain.on('ui:close-tab', (_e, id) => closeTab(id));
  ipcMain.on('ui:move-tab', (_e, id, toIndex) => {
    const t = tabsById.get(id); if (!t) return;
    const arr = sections[t.section].tabs; arr.splice(arr.indexOf(t), 1); arr.splice(Math.max(0, Math.min(toIndex, arr.length)), 0, t);
    pushState();
  });
  ipcMain.on('ui:nav', (_e, action, id) => nav(action, id ? tabsById.get(id) : activeTab()));
  ipcMain.on('ui:navigate', (_e, input) => {
    const t = activeTab(); if (!t) return;
    const url = normalizeInput(input, t.section);
    if (!isInternal(url)) return openExternal(url);
    const target = sectionForUrl(url);
    if (target !== t.section && (target === 'music' || isContentPage(url))) { createTab(target, url); switchSection(target); }
    else t.view.webContents.loadURL(url);
    t.view.webContents.focus();
  });
  ipcMain.on('ui:shortcut', (_e, input) => handleShortcut(input));
  ipcMain.on('ui:focus-view', () => { const t = activeTab(); if (t && currentSection !== 'settings') t.view.webContents.focus(); });

  // Paramètres
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, key, value) => {
    if (!(key in settings.DEFAULTS)) return settings.get();
    if (key === 'adblockEnabled') {
      adblock.setEnabled(value);
      for (const t of tabsById.values()) if (isYouTubeHost(hostOf(t.url))) t.view.webContents.reload();
    } else settings.set(key, value);
    if (key === 'language') {
      t = i18n.translator(value);
      send('i18n:changed', { lang: i18n.normalize(value), languages: i18n.LANGUAGES, strings: i18n.strings(value) });
    }
    if (/^(sb|ryd|language)/.test(key)) {
      const cfg = featuresConfig();
      for (const t of tabsById.values()) if (!t.view.webContents.isDestroyed()) t.view.webContents.send('broom:features-config', cfg);
    }
    return settings.get();
  });
  ipcMain.handle('settings:choose-dir', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('dialog.folder'), defaultPath: settings.get('downloadDir'), properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) settings.set('downloadDir', r.filePaths[0]);
    return settings.get('downloadDir');
  });
  ipcMain.handle('settings:open-dir', () => shell.openPath(settings.get('downloadDir')));
  ipcMain.handle('adblock:update', async () => {
    try { const r = await adblock.update(); for (const t of tabsById.values()) if (isYouTubeHost(hostOf(t.url))) t.view.webContents.reload(); return r; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('ytdlp:version', () => downloader.version());
  ipcMain.handle('ytdlp:update', () => downloader.selfUpdate());
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, userData: app.getPath('userData') }));
  ipcMain.handle('app:clear-data', async (_e, what) => {
    if (what === 'cache') await ses.clearCache();
    else {
      await ses.clearStorageData();
      await ses.clearCache();
      for (const t of tabsById.values()) t.view.webContents.loadURL(HOME[t.section]);
    }
    return true;
  });

  // Téléchargements
  ipcMain.handle('dl:start', (_e, opts) => downloader.start(opts));
  ipcMain.handle('dl:list', () => downloader.list());
  ipcMain.on('dl:cancel', (_e, id) => downloader.cancel(id));
  ipcMain.on('dl:retry', (_e, id) => downloader.retry(id));
  ipcMain.on('dl:remove', (_e, id) => { downloader.remove(id); send('broom:download-list', downloader.list()); });
  ipcMain.on('dl:clear', () => { downloader.clearFinished(); send('broom:download-list', downloader.list()); });
  ipcMain.on('dl:open', (_e, id) => downloader.openFile(id));
  ipcMain.on('dl:show', (_e, id) => downloader.showFile(id));
}

// ---------------------------------------------------------------- démarrage
function setupSession() {
  ses = session.fromPartition(PARTITION);
  const base = app.userAgentFallback;
  // Ne garder que les jetons d'un vrai Chrome (retire "Electron/x" et "BroomTube/x")
  chromeUA = base.replace(/\s([^\s/()]+)\/\S+/g, (m, name) => (['AppleWebKit', 'Chrome', 'Safari'].includes(name) ? m : ''));
  app.userAgentFallback = chromeUA;
  ses.setUserAgent(chromeUA);
  const major = process.versions.chrome.split('.')[0];
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    if (hostOf(details.url) === 'accounts.google.com') {
      h['User-Agent'] = FIREFOX_UA;
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    } else if (h['sec-ch-ua'] || h['Sec-CH-UA']) {
      delete h['Sec-CH-UA'];
      h['sec-ch-ua'] = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not_A Brand";v="24"`;
    }
    cb({ requestHeaders: h });
  });
  // Autoriser plein écran / lecture automatique / notifications de YouTube
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['fullscreen', 'media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'speaker-selection', 'pointerLock'].includes(permission));
  });
  // Téléchargements de fichiers classiques (rares) : dossier de téléchargement
  ses.on('will-download', (_e, item) => { item.setSavePath(path.join(settings.get('downloadDir'), item.getFilename())); });
}

function createWindow() {
  const ws = settings.get('window') || {};
  win = new BrowserWindow({
    width: ws.width || 1380, height: ws.height || 860, x: ws.x, y: ws.y,
    minWidth: 760, minHeight: 480,
    backgroundColor: '#0f0f0f',
    title: 'BroomTube',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e10', symbolColor: '#a1a1a8', height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (ws.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, input) => {
    // Les raccourcis de l'interface sont gérés dans le renderer pour ne pas bloquer la saisie
    if (input.type === 'keyDown' && (input.control || /^f(5|11|12)$/i.test(input.key)) && !['c', 'v', 'x', 'a', 'z', 'y'].includes(input.key.toLowerCase())) {
      if (handleShortcut(input)) e.preventDefault();
    }
  });
  win.on('resize', () => layout());
  win.on('enter-full-screen', () => layout());
  win.on('leave-full-screen', () => { if (fullscreenTab) { const t = fullscreenTab; fullscreenTab = null; t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {}); } layout(); });
  win.on('close', (e) => {
    if (downloader.activeCount() > 0) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: [t('dialog.quit.ok'), t('dialog.cancel')], defaultId: 1, cancelId: 1,
        title: t('dialog.quit.title'), message: t('dialog.quit.message', { n: downloader.activeCount() }),
      });
      if (r === 1) { e.preventDefault(); return; }
      downloader.killAll();
    }
    const b = win.getNormalBounds();
    persistTabs();
    settings.update({ window: { ...b, maximized: win.isMaximized() } });
    settings.saveNow();
  });
  win.on('closed', () => { win = null; });
}

function restoreTabs() {
  const saved = settings.get('savedTabs') || {};
  const restore = settings.get('restoreTabs');
  for (const s of ['youtube', 'music']) {
    const entry = saved[s];
    const urls = restore && entry && Array.isArray(entry.urls) && entry.urls.length ? entry.urls : [HOME[s]];
    urls.forEach((u) => createTab(s, isInternal(u) ? u : HOME[s], { activate: false }));
    const idx = restore && entry ? Math.min(entry.active || 0, sections[s].tabs.length - 1) : 0;
    sections[s].activeId = sections[s].tabs[idx].id;
  }
  const start = settings.get('startSection');
  currentSection = start === 'last' ? settings.get('lastSection') || 'youtube' : start || 'youtube';
  if (!['youtube', 'music'].includes(currentSection)) currentSection = 'youtube';
  layout();
  pushState();
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (url && isInternal(url)) { const s = sectionForUrl(url); createTab(s, url); switchSection(s); }
});

app.whenReady().then(async () => {
  settings.load();
  t = i18n.translator(settings.get('language'));
  downloader.setTranslator((k, v) => t(k, v));
  Menu.setApplicationMenu(null);
  setupSession();
  registerIpc();
  downloader.init(ses, send);
  netfilter.init(() => !!settings.get('adblockEnabled'));
  createWindow();
  // On attend le moteur anti-pub (max 10 s) avant de charger les onglets
  await Promise.race([adblock.init(ses).catch((e) => console.error(e)), new Promise((r) => setTimeout(r, 10000))]);
  restoreTabs();
  setTimeout(() => downloader.autoUpdate().catch(() => {}), 15000);
  const url = process.argv.find((a) => /^https?:\/\//i.test(a));
  if (url && isInternal(url)) { const s = sectionForUrl(url); createTab(s, url); switchSection(s); }
});

app.on('window-all-closed', () => app.quit());
