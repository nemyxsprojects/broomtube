// Google sign-in.
// Google sometimes refuses sign-in from embedded browsers ("This browser or app may not be secure").
// Two ways around it:
//  1. a dedicated sign-in window with a consistent Firefox fingerprint (no ad shield, no debugger);
//  2. importing the Google/YouTube session from the user's own Firefox profile.
const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
  encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2F');

let signinWin = null;

/** Opens the dedicated sign-in window. Resolves true once signed in to YouTube. */
function openSigninWindow({ parent, partition, onDone, url }) {
  if (signinWin && !signinWin.isDestroyed()) { signinWin.focus(); return; }
  signinWin = new BrowserWindow({
    parent, width: 520, height: 720, minWidth: 420, minHeight: 560,
    title: 'Google', autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      preload: path.join(__dirname, '..', 'preload', 'signin-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  const wc = signinWin.webContents;
  wc.setUserAgent(FIREFOX_UA);
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  const finished = (url) => {
    let h = '';
    try { h = new URL(url).hostname; } catch {}
    // Back on YouTube (and not on the sign-in bounce page): done
    if (/(^|\.)youtube\.com$/.test(h) && !/\/signin/.test(url)) {
      const w = signinWin;
      signinWin = null;
      if (w && !w.isDestroyed()) w.close();
      onDone(true);
    }
  };
  wc.on('did-navigate', (_e, url) => finished(url));
  wc.on('did-redirect-navigation', (e) => finished(e.url));
  signinWin.on('closed', () => { signinWin = null; });
  wc.loadURL(url || SIGNIN_URL);
}

// ---------------------------------------------------------------- Firefox import
function firefoxProfiles() {
  const base = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles');
  try {
    return fs.readdirSync(base)
      .map((d) => path.join(base, d))
      .filter((d) => fs.existsSync(path.join(d, 'cookies.sqlite')))
      .sort((a, b) => fs.statSync(path.join(b, 'cookies.sqlite')).mtimeMs - fs.statSync(path.join(a, 'cookies.sqlite')).mtimeMs);
  } catch { return []; }
}
function firefoxAvailable() { return firefoxProfiles().length > 0; }

// Reads Google/YouTube cookies from a copy of Firefox's cookie database (Firefox locks the original).
function readFirefoxCookies(profileDir) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broomtube-ff-'));
  try {
    for (const f of ['cookies.sqlite', 'cookies.sqlite-wal']) {
      const src = path.join(profileDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    const db = new DatabaseSync(path.join(tmp, 'cookies.sqlite'));
    try {
      return db.prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies
        WHERE host LIKE '%youtube.com' OR host = '.google.com' OR host = 'google.com' OR host = 'accounts.google.com'`).all();
    } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function importFromFirefox(ses) {
  const profiles = firefoxProfiles();
  if (!profiles.length) return { ok: false, error: 'no-firefox' };
  let rows = [];
  for (const p of profiles) {
    rows = readFirefoxCookies(p);
    if (rows.some((r) => /youtube\.com$/.test(r.host) && /^(SID|__Secure-3PSID|LOGIN_INFO)$/.test(r.name))) break;
  }
  const signedIn = rows.some((r) => /youtube\.com$/.test(r.host) && r.name === 'LOGIN_INFO');
  if (!signedIn) return { ok: false, error: 'not-signed-in' };
  const now = Date.now() / 1000;
  let count = 0;
  for (const r of rows) {
    // Firefox stores expiry in seconds (older) or milliseconds (newer)
    const expiry = r.expiry > 1e11 ? r.expiry / 1000 : r.expiry;
    if (expiry && expiry < now) continue;
    const host = r.host.replace(/^\./, '');
    try {
      await ses.cookies.set({
        url: `${r.isSecure ? 'https' : 'http'}://${host}${r.path || '/'}`,
        name: r.name, value: r.value, path: r.path || '/',
        domain: r.host.startsWith('.') ? r.host : undefined,
        secure: !!r.isSecure, httpOnly: !!r.isHttpOnly,
        sameSite: r.sameSite === 2 ? 'strict' : r.sameSite === 1 ? 'lax' : 'no_restriction',
        expirationDate: expiry || undefined,
      });
      count++;
    } catch {}
  }
  return { ok: count > 0, count };
}

async function signOut(ses) {
  for (const domain of ['.youtube.com', 'youtube.com', '.google.com', 'accounts.google.com', 'music.youtube.com', 'www.youtube.com']) {
    const list = await ses.cookies.get({ domain });
    for (const c of list) {
      const host = c.domain.replace(/^\./, '');
      await ses.cookies.remove(`https://${host}${c.path}`, c.name).catch(() => {});
    }
  }
}

async function isSignedIn(ses) {
  const c = await ses.cookies.get({ domain: '.youtube.com', name: 'LOGIN_INFO' });
  return c.length > 0;
}

module.exports = { openSigninWindow, importFromFirefox, firefoxAvailable, signOut, isSignedIn, SIGNIN_URL };
