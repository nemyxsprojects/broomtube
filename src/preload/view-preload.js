// Preload des onglets YouTube / YouTube Music (sandboxé, contextIsolation).
// - injecte le bouclier anti-pub dans le "main world"
// - SponsorBlock et Return YouTube Dislike (monde isolé : accès au DOM, pas aux scripts de la page)
const { ipcRenderer, contextBridge, webFrame } = require('electron');

let cfg = { adblock: true, shield: '', youtube: false, sb: { enabled: false }, ryd: { enabled: false } };
try { cfg = ipcRenderer.sendSync('vacuum:view-config', location.href) || cfg; } catch {}

if (cfg.adblock && cfg.shield) {
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: new Function(cfg.shield) });
    else webFrame.executeJavaScript(cfg.shield);
  } catch {
    try { webFrame.executeJavaScript(cfg.shield); } catch {}
  }
}

// Boutons souris précédent / suivant
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); ipcRenderer.send('vacuum:nav', 'back'); }
  if (e.button === 4) { e.preventDefault(); ipcRenderer.send('vacuum:nav', 'forward'); }
});

if (cfg.youtube) {
  const IS_MUSIC = location.hostname === 'music.youtube.com';
  let sb = cfg.sb;
  let ryd = cfg.ryd;

  const videoIdFromUrl = () => {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch { return null; }
  };
  const isShorts = () => location.pathname.startsWith('/shorts/');
  const mainVideo = () => document.querySelector(IS_MUSIC ? 'video' : '#movie_player video.html5-main-video, #movie_player video') ;

  // ================================================================ SponsorBlock
  // Textes traduits fournis par le processus principal
  let strings = cfg.strings || {};
  const tr = (key, vars = {}) => String(strings[key] || key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const catLabel = (c) => strings['sb.cat.' + c] || c;
  const SB_COLORS = {
    sponsor: '#00d400', selfpromo: '#ffff00', interaction: '#cc00ff', intro: '#00ffff', outro: '#0202ed',
    preview: '#008fd6', filler: '#7300ff', music_offtopic: '#ff9900', exclusive_access: '#008a5c',
  };
  let sbVideo = null;      // id de la vidéo pour laquelle les segments sont chargés
  let segments = [];
  let mutedBySb = false;
  let noticeEl = null;
  let noticeTimer = null;
  let manualSeg = null;    // segment "manuel" actuellement affiché

  const modeOf = (seg) => (sb.categories && sb.categories[seg.category]) || 'off';

  async function loadSegments(id) {
    sbVideo = id;
    segments = [];
    removeMarkers();
    if (!sb.enabled || !id) return;
    const res = await ipcRenderer.invoke('sb:segments', id).catch(() => []);
    if (sbVideo !== id || !Array.isArray(res)) return;
    segments = res
      .filter((s) => modeOf(s) !== 'off')
      .filter((s) => s.actionType === 'full' || s.end - s.start >= (sb.minDuration || 0))
      .map((s) => ({ ...s, cancelled: false, reported: false }));
    const full = segments.find((s) => s.actionType === 'full');
    if (full && sb.notify) showNotice(full.category, tr('sb.full', { cat: catLabel(full.category) }), null, 6000);
  }

  function noticeHost() {
    if (IS_MUSIC) return document.body;
    return document.querySelector('#movie_player');
  }
  function showNotice(category, text, action, ms = 4000) {
    const host = noticeHost();
    if (!host) return;
    if (!noticeEl || !noticeEl.isConnected || noticeEl.parentElement !== host) {
      if (noticeEl) noticeEl.remove();
      noticeEl = document.createElement('div');
      noticeEl.className = 'vacuum-sb-notice' + (IS_MUSIC ? ' music' : '');
      host.appendChild(noticeEl);
    }
    noticeEl.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = SB_COLORS[category] || '#fff';
    const label = document.createElement('span');
    label.textContent = text;
    noticeEl.append(dot, label);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); action.run(); });
      noticeEl.appendChild(b);
    }
    requestAnimationFrame(() => noticeEl && noticeEl.classList.add('show'));
    clearTimeout(noticeTimer);
    if (ms) noticeTimer = setTimeout(hideNotice, ms);
  }
  function hideNotice() {
    clearTimeout(noticeTimer);
    if (noticeEl) noticeEl.classList.remove('show');
  }

  function removeMarkers() { document.querySelectorAll('.vacuum-sb-markers').forEach((n) => n.remove()); }
  function renderMarkers(video) {
    if (IS_MUSIC || !sb.markers) return removeMarkers();
    const bar = document.querySelector('#movie_player .ytp-progress-bar');
    if (!bar) return;
    // Avec le streaming SABR, video.duration vaut souvent Infinity : la barre expose la vraie durée
    let dur = video && video.duration;
    if (!dur || !isFinite(dur)) dur = parseFloat(bar.getAttribute('aria-valuemax'));
    if (!dur || !isFinite(dur)) return;
    const visible = segments.filter((s) => s.actionType !== 'full');
    let box = bar.querySelector('.vacuum-sb-markers');
    const sig = sbVideo + ':' + Math.round(dur) + ':' + visible.length;
    if (box && box.dataset.sig === sig) return;
    if (box) box.remove();
    if (!visible.length) return;
    box = document.createElement('div');
    box.className = 'vacuum-sb-markers';
    box.dataset.sig = sig;
    for (const s of visible) {
      const i = document.createElement('i');
      i.style.left = (Math.max(0, s.start) / dur) * 100 + '%';
      i.style.width = (Math.max(0, Math.min(s.end, dur) - s.start) / dur) * 100 + '%';
      i.style.background = SB_COLORS[s.category] || '#fff';
      i.title = catLabel(s.category);
      box.appendChild(i);
    }
    bar.appendChild(box);
  }

  function sbTick() {
    const video = mainVideo();
    if (!video || !segments.length || !sb.enabled) {
      if (mutedBySb && video) { video.muted = false; mutedBySb = false; }
      return;
    }
    renderMarkers(video);
    const t = video.currentTime;
    let inMute = false;
    let inManual = null;
    for (const s of segments) {
      if (s.actionType === 'full') continue;
      const inside = t >= s.start && t < s.end - 0.25;
      if (!inside) { if (t < s.start - 1) s.cancelled = false; continue; }
      const mode = modeOf(s);
      if (s.actionType === 'mute') { if (mode === 'skip' && !s.cancelled) inMute = true; continue; }
      if (mode === 'skip' && !s.cancelled) {
        video.currentTime = Math.min(s.end, (video.duration || s.end) - 0.05);
        if (!s.reported) { s.reported = true; ipcRenderer.send('sb:viewed', s.uuid); }
        if (sb.notify) {
          showNotice(s.category, tr('sb.skipped', { cat: catLabel(s.category) }), {
            label: tr('sb.undo'), run: () => { s.cancelled = true; video.currentTime = s.start; hideNotice(); },
          });
        }
        return;
      }
      if (mode === 'manual' || (mode === 'skip' && s.cancelled)) inManual = s;
    }
    if (inMute && !video.muted) { video.muted = true; mutedBySb = true; }
    if (!inMute && mutedBySb) { video.muted = false; mutedBySb = false; }
    if (inManual && inManual !== manualSeg) {
      manualSeg = inManual;
      const s = inManual;
      showNotice(s.category, catLabel(s.category), {
        label: tr('sb.skip'), run: () => { video.currentTime = s.end; if (!s.reported) { s.reported = true; ipcRenderer.send('sb:viewed', s.uuid); } hideNotice(); },
      }, 0);
    } else if (!inManual && manualSeg) {
      manualSeg = null;
      hideNotice();
    }
  }

  // ================================================================ Return YouTube Dislike
  let rydVideo = null;
  let votes = null;
  const fmt = (n) => {
    const lang = document.documentElement.lang || 'fr';
    try {
      return ryd.compact ? new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString(lang);
    } catch { return String(n); }
  };
  async function loadVotes(id) {
    rydVideo = id;
    votes = null;
    cleanupRyd();
    if (!ryd.enabled || !id || IS_MUSIC) return;
    const v = await ipcRenderer.invoke('ryd:votes', id).catch(() => null);
    if (rydVideo === id && v && typeof v.dislikes === 'number') votes = v;
  }
  function cleanupRyd() {
    document.querySelectorAll('.vacuum-ryd-text, .vacuum-ryd-bar').forEach((n) => n.remove());
    document.querySelectorAll('[data-vacuum-ryd]').forEach((b) => {
      b.classList.replace('ytSpecButtonShapeNextIconLeading', 'ytSpecButtonShapeNextIconButton');
      b.classList.replace('yt-spec-button-shape-next--icon-leading', 'yt-spec-button-shape-next--icon-button');
      delete b.dataset.vacuumRyd;
    });
    document.querySelectorAll('[data-vacuum-ryd-label]').forEach((s) => { s.textContent = s.dataset.vacuumRydLabel; delete s.dataset.vacuumRydLabel; });
  }
  function rydTick() {
    if (!votes || !ryd.enabled) return;
    const text = fmt(votes.dislikes);
    const total = votes.likes + votes.dislikes;
    const tip = `${votes.likes.toLocaleString()} / ${votes.dislikes.toLocaleString()}` + (total ? ` (${((votes.likes / total) * 100).toFixed(1)} % de j'aime)` : '');

    if (isShorts()) {
      const label = document.querySelector('ytd-reel-video-renderer[is-active] dislike-button-view-model [class*="abel"] span, ytd-reel-video-renderer[is-active] #dislike-button [class*="abel"] span');
      if (label && label.textContent !== text) {
        if (!label.dataset.vacuumRydLabel) label.dataset.vacuumRydLabel = label.textContent;
        label.textContent = text;
      }
      return;
    }

    const seg = document.querySelector('ytd-watch-metadata segmented-like-dislike-button-view-model, #top-level-buttons-computed segmented-like-dislike-button-view-model');
    if (!seg) return;
    const dislike = seg.querySelector('dislike-button-view-model button');
    const like = seg.querySelector('like-button-view-model button');
    if (!dislike) return;
    let span = dislike.querySelector('.vacuum-ryd-text');
    if (!span) {
      // Même structure que le compteur du bouton "J'aime" voisin
      const ref = like && like.querySelector('[class*="ButtonTextContent"], [class*="button-text-content"]');
      span = document.createElement(ref ? ref.tagName : 'div');
      span.className = (ref ? ref.className + ' ' : '') + 'vacuum-ryd-text';
      if (ref) span.style.marginLeft = '0';
      const icon = dislike.querySelector('[class*="ButtonShapeNextIcon"], [class*="button-shape-next__icon"]');
      if (icon && icon.nextSibling) dislike.insertBefore(span, icon.nextSibling); else dislike.appendChild(span);
    }
    if (span.textContent !== text) span.textContent = text;
    if (!dislike.dataset.vacuumRyd) {
      dislike.dataset.vacuumRyd = '1';
      dislike.classList.replace('ytSpecButtonShapeNextIconButton', 'ytSpecButtonShapeNextIconLeading');
      dislike.classList.replace('yt-spec-button-shape-next--icon-button', 'yt-spec-button-shape-next--icon-leading');
    }
    if (dislike.title !== tip) dislike.title = tip;

    let bar = seg.querySelector(':scope > .vacuum-ryd-bar');
    if (ryd.bar && total > 0) {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'vacuum-ryd-bar';
        bar.appendChild(document.createElement('i'));
        seg.appendChild(bar);
      }
      bar.firstChild.style.width = ((votes.likes / total) * 100).toFixed(2) + '%';
    } else if (bar) bar.remove();
  }

  // ================================================================ Boucle principale
  let lastId = undefined;
  function onVideoChange(id) {
    hideNotice();
    manualSeg = null;
    loadSegments(id);
    loadVotes(id);
  }
  ipcRenderer.on('vacuum:features-config', (_e, c) => {
    sb = c.sb; ryd = c.ryd; strings = c.strings || strings;
    cleanupRyd();
    onVideoChange(lastId);
  });
  function start() {
    setInterval(() => {
      const id = videoIdFromUrl();
      if (id !== lastId) { lastId = id; onVideoChange(id); }
      try { sbTick(); } catch {}
    }, 150);
    setInterval(() => { try { rydTick(); } catch {} }, 600);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
