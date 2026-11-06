/* global vacuum */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12ZM19 12a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 14 3.2v2.1A7 7 0 0 1 19 12ZM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.2a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3-9-9L4.3 3ZM12 4 9.9 6.1 12 8.2V4Z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>',
};

let state = null;
let lang = 'en';
let strings = {};
let languages = {};
const tr = (key, vars = {}) => String(strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
function applyI18n() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
  $$('[data-i18n-title]').forEach((el) => {
    el.title = tr(el.dataset.i18nTitle) + (el.dataset.keyHint ? '  ' + el.dataset.keyHint : '');
  });
  const sel = $('#language-select');
  sel.innerHTML = Object.entries(languages).map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  sel.value = lang;
}
function setI18n(data) {
  lang = data.lang; strings = data.strings; languages = data.languages;
  applyI18n();
  if (state) render();
  renderDownloads();
  if (state && state.section === 'settings') loadSettings();
  applyMethodToPanel();
}
let settings = {};
const downloads = new Map();
let downloadsOpen = false;
let toastTimer = null;

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------ Mise en page des vues
function sendBounds() {
  const r = $('#content').getBoundingClientRect();
  vacuum.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(sendBounds).observe($('#content'));
window.addEventListener('resize', sendBounds);

// ------------------------------------------------------------ Rendu
function currentTabs() {
  if (!state || state.section === 'settings') return null;
  return state.sections[state.section];
}
function activeTab() {
  const sec = currentTabs();
  return sec ? sec.tabs.find((t) => t.id === sec.activeId) : null;
}

let addressDirty = false;
function render() {
  if (!state) return;
  document.body.dataset.section = state.section;
  $$('.side-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.target === state.section);
    const s = state.sections[b.dataset.target];
    const playing = s && s.tabs.some((t) => t.audible && !t.muted) && b.dataset.target !== state.section;
    let dot = b.querySelector('.dot');
    if (playing && !dot) { dot = document.createElement('i'); dot.className = 'dot'; b.appendChild(dot); }
    if (!playing && dot) dot.remove();
  });
  $('#settings').hidden = state.section !== 'settings';
  if (state.section === 'settings') { loadSettings(); return; }

  renderTabs();
  const t = activeTab();
  $('#btn-back').disabled = !t || !t.canGoBack;
  $('#btn-forward').disabled = !t || !t.canGoForward;
  $('#btn-download').disabled = !t || !t.isVideo;
  $('#address').placeholder = tr(state.section === 'music' ? 'tb.search.music' : 'tb.search.youtube');
  if (t && !addressDirty && document.activeElement !== $('#address')) $('#address').value = prettyUrl(t.url);
  // Formulaire de téléchargement : suit l'onglet courant tant que l'utilisateur ne l'a pas modifié
  if (downloadsOpen && !dlFormDirty && t && t.isVideo) fillDownloadForm(t.url, t.title);
  requestAnimationFrame(sendBounds);
}
function prettyUrl(u) {
  if (!u) return '';
  if (u === 'https://www.youtube.com/' || u === 'https://music.youtube.com/') return '';
  return u;
}

function renderTabs() {
  const sec = currentTabs();
  const box = $('#tabs');
  const existing = new Map($$('.tab', box).map((el) => [+el.dataset.id, el]));
  const ids = new Set(sec.tabs.map((t) => t.id));
  for (const [id, el] of existing) if (!ids.has(id)) el.remove();
  sec.tabs.forEach((t, i) => {
    let el = existing.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = t.id;
      el.draggable = true;
      el.innerHTML = '<span class="fav ph"></span><span class="title"></span><button class="audio" hidden></button><button class="close" title="' + esc(tr('tab.close')) + '  Ctrl+W">' + ICON.close + '</button>';
      el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) vacuum.activateTab(t.id); });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); vacuum.closeTab(t.id); } });
      el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); vacuum.closeTab(t.id); });
      el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); vacuum.nav('mute', t.id); });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/vacuum-tab', String(t.id)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = +e.dataTransfer.getData('text/vacuum-tab');
        const idx = $$('.tab', box).indexOf(el);
        if (id && id !== t.id) vacuum.moveTab(id, idx);
      });
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.classList.toggle('active', t.id === sec.activeId);
    el.classList.toggle('loading', t.loading);
    el.title = t.title;
    el.querySelector('.title').textContent = t.title;
    const fav = el.querySelector('.fav');
    if (t.favicon && fav.tagName !== 'IMG') {
      const img = document.createElement('img'); img.className = 'fav'; img.src = t.favicon; img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'fav ph' }));
      fav.replaceWith(img);
    } else if (t.favicon && fav.tagName === 'IMG' && fav.src !== t.favicon) fav.src = t.favicon;
    const audio = el.querySelector('.audio');
    audio.hidden = !(t.audible || t.muted);
    const ai = t.muted ? 'muted' : 'sound';
    if (audio.dataset.icon !== ai) { audio.innerHTML = ICON[ai]; audio.dataset.icon = ai; audio.title = tr(t.muted ? 'tab.unmute' : 'tab.mute'); }
  });
}

// ------------------------------------------------------------ Barre latérale & outils
$$('.side-btn').forEach((b) => b.addEventListener('click', () => vacuum.switchSection(b.dataset.target)));
$('#new-tab').addEventListener('click', () => vacuum.newTab(state.section));
$('#tabstrip').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs' || e.target.classList.contains('drag-fill')) vacuum.newTab(state.section); });
$('#btn-back').addEventListener('click', () => vacuum.nav('back'));
$('#btn-forward').addEventListener('click', () => vacuum.nav('forward'));
$('#btn-reload').addEventListener('click', () => vacuum.nav('reload'));
$('#btn-home').addEventListener('click', () => vacuum.nav('home'));
$('#address').addEventListener('input', () => { addressDirty = true; });
$('#address').addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0));
$('#address').addEventListener('blur', () => { addressDirty = false; render(); });
$('#address').addEventListener('keydown', (e) => { if (e.key === 'Escape') { addressDirty = false; e.target.blur(); vacuum.focusView(); } });
$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addressDirty = false;
  vacuum.navigate($('#address').value);
  $('#address').blur();
});

// ------------------------------------------------------------ Téléchargements
let dlKind = 'video';
let dlFormDirty = false;
function setKind(k) {
  dlKind = k;
  $$('#dl-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
  $('#dl-video-opts').hidden = k !== 'video';
  $('#dl-audio-opts').hidden = k !== 'audio';
  if (typeof applyMethodToPanel === 'function' && settings.downloadMethod === 'vdh') applyMethodToPanel();
}
$$('#dl-kind button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
$('#dl-url').addEventListener('input', () => { dlFormDirty = true; $('#dl-title').textContent = ''; setThumb($('#dl-url').value.trim()); updatePlaylistRow(); });

function updatePlaylistRow() {
  let hasList = false;
  try { const u = new URL($('#dl-url').value.trim()); hasList = u.searchParams.has('list') || u.pathname === '/playlist'; } catch {}
  $('#dl-playlist-row').hidden = !hasList;
  if (!hasList) $('#dl-playlist').checked = false;
  else { try { $('#dl-playlist').checked = new URL($('#dl-url').value.trim()).pathname === '/playlist'; } catch {} }
}
function videoId(u) {
  try {
    const x = new URL(u);
    if (x.hostname === 'youtu.be') return x.pathname.slice(1, 12);
    if (x.searchParams.get('v')) return x.searchParams.get('v');
    const m = x.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
    return m ? m[2] : '';
  } catch { return ''; }
}
const thumbUrl = (u) => { const id = videoId(u); return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''; };
function setThumb(url) {
  const img = $('#dl-thumb'); const src = thumbUrl(url);
  img.hidden = !src;
  if (src && img.src !== src) img.src = src;
}
function fillDownloadForm(url, title, kind) {
  setThumb(url);
  $('#dl-url').value = url || '';
  $('#dl-title').textContent = title ? title.replace(/ - YouTube( Music)?$/, '') : '';
  $('#dl-quality').value = settings.defaultVideoQuality || 'best';
  $('#dl-audio-format').value = settings.defaultAudioFormat || 'mp3';
  const defKind = kind || (state && state.section === 'music' && settings.musicDefaultsToAudio ? 'audio' : 'video');
  setKind(defKind);
  updatePlaylistRow();
  applyMethodToPanel();
}

function openDownloads(open = !downloadsOpen) {
  downloadsOpen = open;
  $('#downloads').hidden = !open;
  $('#btn-downloads').classList.toggle('on', open);
  if (open) {
    dlFormDirty = false;
    const t = activeTab();
    if (t && t.isVideo) fillDownloadForm(t.url, t.title);
    else if (!$('#dl-url').value) fillDownloadForm('', '');
  }
  requestAnimationFrame(sendBounds);
}
$('#btn-downloads').addEventListener('click', () => openDownloads());
$('#dl-close').addEventListener('click', () => openDownloads(false));
$('#btn-download').addEventListener('click', () => {
  const t = activeTab();
  if (!t) return;
  openDownloads(true);
  dlFormDirty = false;
  fillDownloadForm(t.url, t.title);
  $('#dl-go').focus();
});
$('#dl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#dl-url').value.trim();
  if (!/^https?:\/\//i.test(url)) { toast(tr('toast.invalidLink')); return; }
  if (settings.downloadMethod === 'vdh') {
    const r = await vacuum.vdhOpen(url);
    toast(r.ok ? tr('toast.vdh') : tr('toast.error', { msg: r.error }), 5000);
    return;
  }
  const btn = $('#dl-go');
  btn.disabled = true;
  try {
    const job = await vacuum.startDownload({
      url, title: $('#dl-title').textContent || url, kind: dlKind,
      quality: $('#dl-quality').value, audioFormat: $('#dl-audio-format').value,
      playlist: !$('#dl-playlist-row').hidden && $('#dl-playlist').checked,
    });
    downloads.set(job.id, job);
    renderDownloads();
    toast(tr('toast.added'));
  } catch (err) {
    toast(tr('toast.error', { msg: err.message }), 5000);
  } finally {
    btn.disabled = false;
  }
});
$('#dl-clear').addEventListener('click', () => vacuum.clearDownloads());
$('#dl-open-folder').addEventListener('click', () => vacuum.openDir());


function renderDownloads() {
  const list = $('#dl-list');
  const items = [...downloads.values()].sort((a, b) => b.id - a.id);
  const active = items.filter((d) => ['queued', 'starting', 'downloading', 'processing'].includes(d.status)).length;
  $('#dl-badge').hidden = active === 0;
  $('#dl-badge').textContent = active;
  if (!items.length) { list.innerHTML = `<div class="empty">${esc(tr('dl.empty'))}</div>`; return; }
  list.innerHTML = items.map((d) => {
    const running = ['starting', 'downloading', 'processing', 'queued'].includes(d.status);
    let st = tr('dl.st.' + d.status);
    if (d.status === 'downloading') st = `${Math.floor(d.percent)} %${d.size ? ' · ' + d.size : ''}${d.speed ? ' · ' + d.speed : ''}`;
    if (d.status === 'done' && d.file) st = (d.file.split('.').pop() || '').toUpperCase();
    const acts = [];
    if (running) acts.push(`<button data-act="cancel">${tr('dl.act.cancel')}</button>`);
    if (d.status === 'done') acts.push(`<button data-act="open">${tr('dl.act.open')}</button>`, `<button data-act="show">${tr('dl.act.show')}</button>`);
    if (d.status === 'error' || d.status === 'cancelled') acts.push(`<button data-act="retry">${tr('dl.act.retry')}</button>`);
    if (!running) acts.push(`<button data-act="remove">${tr('dl.act.remove')}</button>`);
    const pct = d.status === 'processing' || d.status === 'starting' ? 100 : d.status === 'queued' ? 0 : d.percent;
    return `<div class="dl-item ${d.status}" data-id="${d.id}">
      <div class="thumb">${thumbUrl(d.url) ? `<img src="${esc(thumbUrl(d.url))}" alt="">` : ''}<span class="kind">${d.kind === 'audio' ? ICON.audio : ICON.video}</span></div>
      <div class="info">
        <div class="name" title="${esc(d.file || d.title)}">${esc(d.title.replace(/ - YouTube( Music)?$/, ''))}</div>
        ${['downloading', 'processing', 'starting'].includes(d.status) ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="meta"><span class="st">${esc(st)}</span><span class="acts">${acts.join('')}</span></div>
        ${d.status === 'error' && d.error ? `<div class="err">${esc(d.error)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}
$('#dl-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = +b.closest('.dl-item').dataset.id;
  ({ cancel: vacuum.cancelDownload, open: vacuum.openDownload, show: vacuum.showDownload, retry: vacuum.retryDownload, remove: vacuum.removeDownload })[b.dataset.act](id);
});
vacuum.onDownloadUpdate((d) => {
  const prev = downloads.get(d.id);
  downloads.set(d.id, d);
  renderDownloads();
  if (prev && prev.status !== 'done' && d.status === 'done') toast(tr('toast.done', { title: d.title.replace(/ - YouTube( Music)?$/, '') }), 3500);
  if (prev && prev.status !== 'error' && d.status === 'error') { toast(tr('toast.failed'), 3500); if (!downloadsOpen) openDownloads(true); }
});
vacuum.onDownloadList((list) => { downloads.clear(); list.forEach((d) => downloads.set(d.id, d)); renderDownloads(); });

// ------------------------------------------------------------ Paramètres
async function loadSettings() {
  settings = await vacuum.getSettings();
  $$('#settings [data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
  $('#dl-dir').textContent = settings.downloadDir;
  renderSbCategories();
  updateMethodUI();
  $('#adblock-info').textContent = settings.adblockLastUpdate
    ? tr('s.ads.updated', { date: new Date(settings.adblockLastUpdate).toLocaleString(lang) })
    : tr('s.ads.builtin');
}
$$('#settings [data-key]').forEach((el) => el.addEventListener('change', async () => {
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number') v = Number(v);
  settings = await vacuum.setSetting(el.dataset.key, v);
  if (el.dataset.key === 'sbEnabled') renderSbCategories();
  if (el.dataset.key === 'downloadMethod') updateMethodUI();
  if (el.dataset.key === 'adblockEnabled') toast(tr(v ? 'toast.adOn' : 'toast.adOff'));
}));
$('#dl-dir-choose').addEventListener('click', async () => { const d = await vacuum.chooseDir(); $('#dl-dir').textContent = d; settings.downloadDir = d; });
$('#dl-dir-open').addEventListener('click', () => vacuum.openDir());
$('#adblock-update').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = tr('s.updating');
  const r = await vacuum.updateAdblock();
  b.disabled = false; b.textContent = tr('s.update');
  if (r.ok) toast(tr('toast.filters', { lists: r.lists, total: r.total })); else toast(tr('toast.updateFailed', { msg: r.error || 'network' }), 4000);
  loadSettings();
});
const SB_CATS = [
  ['sponsor', '#00d400'], ['selfpromo', '#ffff00'], ['interaction', '#cc00ff'], ['intro', '#00ffff'], ['outro', '#0202ed'],
  ['preview', '#008fd6'], ['filler', '#7300ff'], ['music_offtopic', '#ff9900'], ['exclusive_access', '#008a5c'],
];
function renderSbCategories() {
  const box = $('#sb-cats');
  const cats = settings.sbCategories || {};
  box.classList.toggle('disabled', !settings.sbEnabled);
  box.innerHTML = SB_CATS.map(([key, color]) => `
    <label class="cat"><span class="cat-name"><i class="cat-dot" style="background:${color}"></i>${esc(tr('sb.cat.' + key))}</span>
      <select data-cat="${key}">
        <option value="skip"${cats[key] === 'skip' ? ' selected' : ''}>${tr('s.sb.mode.skip')}</option>
        <option value="manual"${cats[key] === 'manual' ? ' selected' : ''}>${tr('s.sb.mode.manual')}</option>
        <option value="off"${cats[key] === 'off' ? ' selected' : ''}>${tr('s.sb.mode.off')}</option>
      </select></label>`).join('');
}
$('#sb-cats').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-cat]');
  if (!sel) return;
  settings = await vacuum.setSetting('sbCategories', { ...settings.sbCategories, [sel.dataset.cat]: sel.value });
});

let vdh = null;
async function updateMethodUI() {
  const isVdh = settings.downloadMethod === 'vdh';
  $$('#settings .ytdlp-only').forEach((r) => { r.hidden = isVdh; });
  $('#vdh-row').hidden = !isVdh;
  $('#dl-method-info').textContent = isVdh
    ? tr('s.dl.method.vdh')
    : tr('s.dl.method.ytdlp');
  applyMethodToPanel();
  if (!isVdh) return;
  vdh = await vacuum.vdhStatus();
  $('#vdh-info').textContent = tr(!vdh.firefox ? 's.vdh.noFirefox' : vdh.extension ? 's.vdh.found' : 's.vdh.missing');
  $('#vdh-install').hidden = !vdh.firefox || vdh.extension;
}
$('#vdh-install').addEventListener('click', () => vdh && vacuum.vdhOpen(vdh.installUrl));
function applyMethodToPanel() {
  const isVdh = settings.downloadMethod === 'vdh';
  $('#dl-kind').hidden = isVdh;
  $('#dl-video-opts').hidden = isVdh || dlKind !== 'video';
  $('#dl-audio-opts').hidden = isVdh || dlKind !== 'audio';
  if (isVdh) $('#dl-playlist-row').hidden = true;
  $('#dl-go').textContent = tr(isVdh ? 'dl.go.vdh' : 'dl.go');
}

async function refreshYtdlp() { $('#ytdlp-info').textContent = tr('s.dl.version', { version: await vacuum.ytdlpVersion() }); }
$('#ytdlp-update').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = tr('s.updating');
  const r = await vacuum.ytdlpUpdate();
  b.disabled = false; b.textContent = tr('s.update');
  $('#ytdlp-info').textContent = tr('s.dl.version', { version: r.version });
  toast(r.ok ? tr('toast.ytdlpOk', { version: r.version }) : tr('toast.ytdlpFail'), 4000);
});
$('#clear-cache').addEventListener('click', async () => { await vacuum.clearData('cache'); toast(tr('toast.cache')); });
$('#clear-all').addEventListener('click', async () => {
  if (!confirm(tr('confirm.clearAll'))) return;
  await vacuum.clearData('all'); toast(tr('toast.data'));
});

// ------------------------------------------------------------ Commandes envoyées par le processus principal
vacuum.onCommand((cmd) => {
  if (cmd === 'focus-address') { if (state.section !== 'settings') { $('#address').focus(); $('#address').select(); } }
  else if (cmd === 'toggle-downloads') openDownloads();
  else if (cmd === 'download-current') { const t = activeTab(); if (t && t.isVideo) $('#btn-download').click(); else openDownloads(true); }
  else if (cmd && cmd.type === 'download') {
    openDownloads(true);
    dlFormDirty = true;
    fillDownloadForm(cmd.url, cmd.title, cmd.kind);
  }
});

// Raccourcis quand le focus est dans l'interface (Ctrl+T etc. sont déjà interceptés par le main)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && downloadsOpen && !e.target.closest('input,select')) openDownloads(false);
});

// ------------------------------------------------------------ Init
vacuum.onState((s) => { state = s; render(); });
vacuum.onI18n((d) => setI18n(d));
(async () => {
  settings = await vacuum.getSettings();
  { const d = await vacuum.getI18n(); lang = d.lang; strings = d.strings; languages = d.languages; applyI18n(); }
  applyMethodToPanel();
  state = await vacuum.getState();
  render();
  sendBounds();
  const list = await vacuum.listDownloads();
  list.forEach((d) => downloads.set(d.id, d));
  renderDownloads();
  const info = await vacuum.appInfo();
  $('#about').textContent = `Vacuum Desktop ${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`;
  refreshYtdlp();
})();
