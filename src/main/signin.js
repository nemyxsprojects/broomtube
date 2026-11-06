// Google sign-in in a dedicated window.
// Google sometimes refuses sign-in from embedded browsers ("This browser or app may not be secure").
// The window presents a consistent Firefox fingerprint (see signin-preload.js), has no ad shield and no
// debugger attached, which is what Google accepts most of the time. When Google still refuses, the
// window closes and the app tells the user, who can try again.
const { BrowserWindow } = require('electron');
const path = require('path');

const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
  encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2F');

let signinWin = null;

function openSigninWindow({ parent, partition, onDone, onRejected, url }) {
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
  wc.setWindowOpenHandler(({ url: u }) => { wc.loadURL(u); return { action: 'deny' }; });
  const close = () => {
    const w = signinWin;
    signinWin = null;
    if (w && !w.isDestroyed()) w.close();
  };
  const check = (u) => {
    // Google refused this window
    if (/accounts\.google\.com\/.*signin\/rejected/.test(u)) { close(); if (onRejected) onRejected(); return; }
    let host = '';
    try { host = new URL(u).hostname; } catch {}
    // Back on YouTube (past the sign-in bounce page): signed in
    if (/(^|\.)youtube\.com$/.test(host) && !/\/signin/.test(u)) { close(); onDone(); }
  };
  wc.on('did-navigate', (_e, u) => check(u));
  wc.on('did-redirect-navigation', (e) => check(e.url));
  signinWin.on('closed', () => { signinWin = null; });
  wc.loadURL(url || SIGNIN_URL);
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

module.exports = { openSigninWindow, signOut, isSignedIn };
