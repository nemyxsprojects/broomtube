// Paramètres persistants de l'application (userData/settings.json)
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  language: 'en',                   // en | fr | es | de | it | pt-BR
  adblockEnabled: true,
  adblockLastUpdate: 0,
  startSection: 'youtube',          // 'youtube' | 'music' | 'last'
  lastSection: 'youtube',
  restoreTabs: true,
  downloadDir: '',                  // vide = dossier Téléchargements de Windows
  defaultVideoQuality: 'best',      // best | 2160 | 1440 | 1080 | 720 | 480 | 360
  defaultAudioFormat: 'mp3',        // mp3 | m4a | opus
  musicDefaultsToAudio: true,
  useCookiesForDownloads: true,
  ytdlpLastUpdate: 0,
  window: null,
  embedMetadata: true,
  sponsorBlockRemove: false,
  openFolderWhenDone: false,
  downloadMethod: 'ytdlp',          // 'ytdlp' | 'vdh' (Video DownloadHelper via Firefox)
  savedTabs: { youtube: [], music: [] },

  // SponsorBlock (dans le lecteur)
  sbEnabled: true,
  sbCategories: {                   // 'skip' = passer auto, 'manual' = bouton Passer, 'off' = ignorer
    sponsor: 'skip', selfpromo: 'skip', interaction: 'skip', intro: 'manual', outro: 'manual',
    preview: 'manual', filler: 'off', music_offtopic: 'skip', exclusive_access: 'manual',
  },
  sbShowMarkers: true,
  sbNotify: true,
  sbMinDuration: 0,                 // secondes : ignorer les segments plus courts
  sbCountViews: true,               // signaler les segments passés (statistiques SponsorBlock)

  // Return YouTube Dislike
  rydEnabled: true,
  rydShowBar: true,
  rydCompact: true,
};
const CATEGORY_KEYS = Object.keys(DEFAULTS.sbCategories);

let file;

// Language chosen in the installer (written by Inno Setup next to the app resources)
function installLanguage() {
  try {
    const code = fs.readFileSync(path.join(process.resourcesPath || '', 'install-language'), 'utf8').trim();
    return /^(en|fr|es|de|it|pt-BR)$/.test(code) ? code : 'en';
  } catch { return 'en'; }
}
let data = null;

function load() {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...DEFAULTS, ...raw };
    if (!raw.language) data.language = installLanguage();
  } catch {
    data = { ...DEFAULTS, language: installLanguage() };
  }
  if (!data.downloadDir) data.downloadDir = app.getPath('downloads');
  // Fusion profonde des catégories (nouvelles catégories ajoutées dans une mise à jour)
  data.sbCategories = { ...DEFAULTS.sbCategories, ...(data.sbCategories || {}) };
  for (const k of Object.keys(data.sbCategories)) if (!CATEGORY_KEYS.includes(k)) delete data.sbCategories[k];
  return data;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Impossible de sauvegarder les paramètres', e);
  }
}

function get(key) { if (!data) load(); return key ? data[key] : data; }
function set(key, value) { if (!data) load(); data[key] = value; save(); }
function update(patch) { if (!data) load(); Object.assign(data, patch); save(); }

module.exports = { load, get, set, update, save, saveNow, DEFAULTS };
