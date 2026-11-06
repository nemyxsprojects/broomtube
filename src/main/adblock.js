// Blocage des publicités : moteur @ghostery/adblocker (syntaxe uBlock Origin / EasyList,
// filtres réseau, filtres cosmétiques et scriptlets) + règles maison pour YouTube.
// Le complément côté page (nettoyage des réponses du player et saut des pubs vidéo)
// se trouve dans src/preload/adshield.js.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const settings = require('./settings');

const GH = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const UBO = 'https://ublockorigin.github.io/uAssets/filters';

// Listes uBlock Origin officielles (les plus à jour pour YouTube) + EasyList/EasyPrivacy.
const LISTS = [
  `${UBO}/filters.txt`,
  `${UBO}/quick-fixes.txt`,
  `${UBO}/unbreak.txt`,
  `${UBO}/privacy.txt`,
  `${UBO}/badware.txt`,
  `${GH}/ublock-origin/filters-2024.txt`,
  `${GH}/ublock-origin/filters-2023.txt`,
  `${GH}/easylist/easylist.txt`,
  `${GH}/easylist/easyprivacy.txt`,
  `${GH}/peter-lowe/serverlist.txt`,
];
const RESOURCES = `${GH}/ublock-origin/resources.json`;

// Règles réseau supplémentaires ciblées YouTube / Google Ads.
const CUSTOM_FILTERS = `
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||google-analytics.com^
||adservice.google.*^
||youtube.com/api/stats/ads$xmlhttprequest,ping,image,other
||youtube.com/pagead/$~document
||youtube.com/get_midroll_
||youtube.com/youtubei/v1/player/ad_break
||static.doubleclick.net^
! Le player YouTube attend ces requêtes de télémétrie avant de démarrer quand les pubs sont retirées :
! les bloquer bloque la lecture automatique.
@@||youtube.com/api/stats/qoe$xmlhttprequest,ping,image
@@||youtube.com/generate_204$image,xmlhttprequest,ping
@@||youtube.com/ptracking$xmlhttprequest,ping,image
@@||youtube.com/youtubei/v1/log_event$xmlhttprequest,ping
`;

const UPDATE_EVERY_MS = 24 * 3600 * 1000;

let blocker = null;
let sessions = new Set();
let enginePath;

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function buildEngine() {
  const results = await Promise.allSettled(LISTS.map(fetchText));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  results.forEach((r, i) => { if (r.status === 'rejected') console.warn('[adblock] liste ignorée', LISTS[i], r.reason?.message); });
  if (lists.length === 0) throw new Error('Aucune liste de filtres téléchargée');
  // Les scriptlets uBO (##+js) ne sont pas exécutés correctement par le moteur sous Electron
  // (collisions entre scriptlets qui cassent YouTube) : on les retire. Leur rôle sur YouTube
  // (json-prune, set-constant…) est assuré par src/preload/adshield.js.
  const text = [...lists, CUSTOM_FILTERS].join('\n')
    .split('\n')
    .filter((l) => !/#@?#\+js\(|##\^/.test(l))
    .join('\n');
  const engine = ElectronBlocker.parse(text, {
    enableCompression: true,
    loadCosmeticFilters: false,
    loadNetworkFilters: true,
  });
  try {
    const resources = await fetchText(RESOURCES);
    engine.updateResources(resources, '' + resources.length);
  } catch (e) {
    console.warn('[adblock] resources.json indisponible', e.message);
  }
  fs.writeFileSync(enginePath, Buffer.from(engine.serialize()));
  settings.set('adblockLastUpdate', Date.now());
  return { engine, listCount: lists.length, total: LISTS.length };
}

function loadCached() {
  try {
    if (fs.existsSync(enginePath)) return ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(enginePath)));
  } catch (e) {
    console.warn('[adblock] cache invalide, reconstruction', e.message);
  }
  return null;
}

function attach(engine) {
  const enabled = settings.get('adblockEnabled');
  if (blocker) for (const s of sessions) { try { blocker.disableBlockingInSession(s); } catch {} }
  blocker = engine;
  // Les filtres cosmétiques du moteur (preload injecté dans la page) perturbent aléatoirement le
  // démarrage du player YouTube : on ne garde que le filtrage réseau. Le masquage cosmétique est
  // assuré par src/preload/adblock.css (insertCSS, invisible pour la page).
  blocker.config.loadCosmeticFilters = false;
  if (enabled) for (const s of sessions) blocker.enableBlockingInSession(s);
}

/** Initialise le bloqueur. Résout dès qu'un moteur est disponible (cache ou réseau). */
async function init(ses) {
  enginePath = path.join(app.getPath('userData'), 'adblock-engine-v2.bin');
  sessions.add(ses);
  const cached = loadCached();
  if (cached) {
    attach(cached);
    if (Date.now() - (settings.get('adblockLastUpdate') || 0) > UPDATE_EVERY_MS) {
      update().catch((e) => console.warn('[adblock] mise à jour échouée', e.message));
    }
    return;
  }
  try {
    const { engine } = await buildEngine();
    attach(engine);
  } catch (e) {
    console.warn('[adblock] pas de moteur réseau, règles maison seulement', e.message);
    attach(ElectronBlocker.parse(CUSTOM_FILTERS, { loadCosmeticFilters: false, loadNetworkFilters: true }));
  }
}

async function update() {
  const r = await buildEngine();
  attach(r.engine);
  return { ok: true, lists: r.listCount, total: r.total, date: settings.get('adblockLastUpdate') };
}

function setEnabled(on) {
  settings.set('adblockEnabled', !!on);
  if (!blocker) return;
  for (const s of sessions) {
    try {
      if (on && !blocker.isBlockingEnabled(s)) blocker.enableBlockingInSession(s);
      if (!on && blocker.isBlockingEnabled(s)) blocker.disableBlockingInSession(s);
    } catch (e) { console.warn(e); }
  }
}

module.exports = { init, update, setEnabled };
