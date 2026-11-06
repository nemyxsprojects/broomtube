// Services tiers intégrés : SponsorBlock, Return YouTube Dislike, Video DownloadHelper (via Firefox).
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const UA = `VacuumDesktop/${app.getVersion()}`;
const SB_API = 'https://sponsor.ajay.app/api';
const RYD_API = 'https://returnyoutubedislikeapi.com';
const VDH_FIREFOX_ID = '{b9db16a4-6edc-47ec-a1f4-b86292ed211d}';
const VDH_AMO = 'https://addons.mozilla.org/firefox/addon/video-downloadhelper/';

const cache = new Map(); // clé -> { t, value }
const TTL = 10 * 60 * 1000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.value;
  const value = await fn();
  cache.set(key, { t: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const isId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);

// ---------------------------------------------------------------- SponsorBlock
// Requête par préfixe de hash (le serveur ne voit pas quelle vidéo est regardée).
async function sponsorSegments(videoId, categories) {
  if (!isId(videoId) || !categories.length) return [];
  const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const key = `sb:${prefix}:${categories.join(',')}`;
  try {
    const list = await cached(key, () => getJson(
      `${SB_API}/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(categories))}&actionTypes=${encodeURIComponent('["skip","mute","full"]')}`,
    ));
    const entry = (list || []).find((v) => v.videoID === videoId);
    return entry ? entry.segments.map((s) => ({
      uuid: s.UUID, category: s.category, actionType: s.actionType, start: s.segment[0], end: s.segment[1],
    })) : [];
  } catch (e) {
    return { error: e.message };
  }
}
function sponsorViewed(uuid) {
  if (typeof uuid !== 'string' || uuid.length > 100) return;
  fetch(`${SB_API}/viewedVideoSponsorTime?UUID=${encodeURIComponent(uuid)}`, { method: 'POST', headers: { 'User-Agent': UA } }).catch(() => {});
}

// ---------------------------------------------------------------- Return YouTube Dislike
async function dislikes(videoId) {
  if (!isId(videoId)) return null;
  try {
    return await cached(`ryd:${videoId}`, () => getJson(`${RYD_API}/votes?videoId=${videoId}`));
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------- Video DownloadHelper
// VDH est une extension de navigateur (+ appli compagnon) : elle ne peut pas tourner dans l'app.
// On s'appuie donc sur Firefox, où l'extension prend en charge YouTube.
function firefoxPath() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Mozilla Firefox', 'firefox.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
function vdhInstalled() {
  const profiles = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles');
  try {
    return fs.readdirSync(profiles).some((p) => fs.existsSync(path.join(profiles, p, 'extensions', `${VDH_FIREFOX_ID}.xpi`)));
  } catch { return false; }
}
function vdhStatus() {
  const firefox = firefoxPath();
  return { firefox: !!firefox, extension: firefox ? vdhInstalled() : false, installUrl: VDH_AMO };
}
function openInFirefox(url) {
  const ff = firefoxPath();
  if (!ff) return { ok: false, error: 'Firefox introuvable' };
  if (!/^https:\/\/([\w-]+\.)*(youtube\.com|youtu\.be|mozilla\.org)\//.test(url)) return { ok: false, error: 'Lien non pris en charge' };
  spawn(ff, ['-new-tab', url], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

module.exports = { sponsorSegments, sponsorViewed, dislikes, vdhStatus, openInFirefox };
