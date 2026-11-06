// Téléchargeur intégré basé sur yt-dlp + ffmpeg.
const { app, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

let ses = null;
let t = (k) => k;
function setTranslator(fn) { t = fn; }
let notify = () => {};
const jobs = new Map(); // id -> job
let nextId = 1;

function resourcesBin() {
  return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', '..', 'bin');
}
// yt-dlp est copié dans userData pour pouvoir être mis à jour (yt-dlp -U) sans droits admin.
function ytdlpPath() {
  const userBin = path.join(app.getPath('userData'), 'bin');
  const userExe = path.join(userBin, 'yt-dlp.exe');
  const bundled = path.join(resourcesBin(), 'yt-dlp.exe');
  try {
    if (!fs.existsSync(userExe) && fs.existsSync(bundled)) {
      fs.mkdirSync(userBin, { recursive: true });
      fs.copyFileSync(bundled, userExe);
    }
  } catch {}
  return fs.existsSync(userExe) ? userExe : bundled;
}
const ffmpegDir = () => resourcesBin();

function init(session, notifier) {
  ses = session;
  notify = notifier;
}

function publicJob(j) {
  const { proc, cookieFile, log, opts, ...rest } = j;
  return { ...rest, log: log.slice(-15) };
}
function emit(j) { notify('vacuum:download-update', publicJob(j)); }
function list() { return [...jobs.values()].map(publicJob).sort((a, b) => b.id - a.id); }

async function writeCookies() {
  const cookies = [
    ...(await ses.cookies.get({ domain: '.youtube.com' })),
    ...(await ses.cookies.get({ domain: '.google.com' })),
  ];
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain;
    lines.push([domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  const f = path.join(app.getPath('temp'), `vacuum-cookies-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

const MAX_CONCURRENT = 2;
const ACTIVE = ['starting', 'downloading', 'processing'];

/**
 * Ajoute un téléchargement à la file. opts: { url, title, kind: 'video'|'audio', quality, audioFormat, playlist }
 */
function start(opts) {
  const id = nextId++;
  const job = {
    id, url: opts.url, title: opts.title || opts.url, kind: opts.kind, opts,
    status: 'queued', percent: 0, speed: '', eta: '', size: '', file: '', error: '',
    startedAt: Date.now(), log: [],
  };
  jobs.set(id, job);
  emit(job);
  pump();
  return publicJob(job);
}

function pump() {
  const running = [...jobs.values()].filter((j) => ACTIVE.includes(j.status)).length;
  const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.id - b.id);
  for (let i = 0; i < Math.min(MAX_CONCURRENT - running, next.length); i++) {
    const j = next[i];
    runJob(j).catch((e) => { j.status = 'error'; j.error = e.message; emit(j); pump(); });
  }
}

async function runJob(job) {
  const opts = job.opts;
  const s = settings.get();
  job.status = 'starting';
  emit(job);
  const outDir = s.downloadDir || app.getPath('downloads');
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    '--newline', '--progress', '--no-mtime', '--no-colors', '--windows-filenames',
    '--progress-template', 'download:BYTPROG %(progress)j',
    '--print', 'after_move:BYTFILE %(filepath)s',
    '--ffmpeg-location', ffmpegDir(),
    // Runtime JS pour résoudre les challenges YouTube : le Node.js intégré à l'app (ELECTRON_RUN_AS_NODE).
    // Sans lui, yt-dlp perd des formats et se fait bien plus souvent limiter.
    '--js-runtimes', 'node:' + process.execPath,
    // Limiter l'impact du rate-limit YouTube : réessais avec attente exponentielle
    '--retries', '10', '--fragment-retries', '10', '--extractor-retries', '5',
    '--retry-sleep', 'http:exp=1:30', '--retry-sleep', 'fragment:exp=1:30', '--retry-sleep', 'extractor:exp=2:60',
    '-P', outDir,
    '-o', opts.playlist ? '%(playlist_title|Playlist)s/%(playlist_index)03d - %(title)s [%(id)s].%(ext)s' : '%(title)s [%(id)s].%(ext)s',
    opts.playlist ? '--yes-playlist' : '--no-playlist',
  ];
  // Playlists : on espace les requêtes pour ne pas se faire bloquer
  if (opts.playlist) args.push('--sleep-requests', '1', '--sleep-interval', '3', '--max-sleep-interval', '8');
  if (opts.kind === 'audio') {
    const fmt = opts.audioFormat || s.defaultAudioFormat || 'mp3';
    args.push('-f', fmt === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b', '-x', '--audio-format', fmt, '--audio-quality', '0');
    if (s.embedMetadata) args.push('--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    const q = opts.quality || s.defaultVideoQuality || 'best';
    const sort = q === 'best' ? 'res,ext:mp4:m4a' : `res:${q},ext:mp4:m4a`;
    args.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4');
    if (s.embedMetadata) args.push('--embed-metadata', '--embed-chapters');
  }
  if (s.sponsorBlockRemove) args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');

  // Les cookies de la session connectée dans l'app réduisent fortement les blocages "not a bot"
  try {
    if (s.useCookiesForDownloads && ses) {
      job.cookieFile = await writeCookies();
      args.push('--cookies', job.cookieFile);
    }
  } catch (e) { job.log.push('cookies: ' + e.message); }

  args.push('--', opts.url);
  if (job.status === 'cancelled') return;

  const proc = spawn(ytdlpPath(), args, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ELECTRON_RUN_AS_NODE: '1' },
  });
  job.proc = proc;
  job.status = 'downloading';
  emit(job);

  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.search(/\r?\n|\r/)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(job, line);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => { job.status = 'error'; job.error = e.message; emit(job); });
  proc.on('close', (code) => {
    if (job.cookieFile) fs.rm(job.cookieFile, () => {});
    job.proc = null;
    if (job.status !== 'cancelled') {
      if (code === 0) {
        job.status = 'done'; job.percent = 100; job.eta = ''; job.speed = '';
        if (settings.get('openFolderWhenDone') && job.file) shell.showItemInFolder(job.file);
      } else {
        job.status = 'error';
        job.error = job.error || job.log.filter((l) => /ERROR/.test(l)).pop() || t('dl.err.exit', { code });
        if (/429|Too Many Requests|not a bot|Sign in to confirm/i.test(job.error)) {
          job.error += ' — ' + t('dl.err.ratelimit');
        }
      }
    }
    emit(job);
    pump();
  });
}

function retry(id) {
  const j = jobs.get(id);
  if (!j || ACTIVE.includes(j.status) || j.status === 'queued') return;
  Object.assign(j, { status: 'queued', percent: 0, error: '', speed: '', eta: '', log: [] });
  emit(j);
  pump();
}

const fmtBytes = (n) => {
  if (!n || !isFinite(n)) return '';
  const u = ['o', 'Ko', 'Mo', 'Go']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtEta = (s) => (s == null || !isFinite(s) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

let lastEmit = 0;
function handleLine(job, line) {
  if (line.startsWith('BYTPROG ')) {
    try {
      const p = JSON.parse(line.slice(8));
      const total = p.total_bytes || p.total_bytes_estimate;
      if (total && p.downloaded_bytes != null) job.percent = Math.min(100, (p.downloaded_bytes / total) * 100);
      job.speed = p.speed ? fmtBytes(p.speed) + '/s' : '';
      job.eta = fmtEta(p.eta);
      job.size = fmtBytes(total);
      job.status = p.status === 'finished' ? 'processing' : 'downloading';
    } catch {}
    const now = Date.now();
    if (now - lastEmit > 250) { lastEmit = now; emit(job); }
    return;
  }
  if (line.startsWith('BYTFILE ')) {
    job.file = line.slice(8).trim();
    job.title = path.basename(job.file);
    emit(job);
    return;
  }
  job.log.push(line);
  if (job.log.length > 200) job.log.shift();
  if (/\[(Merger|ExtractAudio|EmbedThumbnail|Metadata|FixupM3u8|VideoConvertor|SponsorBlock|ModifyChapters)\]/.test(line)) {
    job.status = 'processing';
    emit(job);
  } else if (/^ERROR/.test(line)) {
    job.error = line.replace(/^ERROR:\s*/, '');
  }
}

function cancel(id) {
  const j = jobs.get(id);
  if (!j || ['done', 'error', 'cancelled'].includes(j.status)) return;
  const proc = j.proc;
  j.status = 'cancelled';
  // Tue aussi ffmpeg lancé par yt-dlp
  if (proc) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  emit(j);
  pump();
}
function remove(id) {
  const j = jobs.get(id);
  if (j && (ACTIVE.includes(j.status) || j.status === 'queued')) cancel(id);
  jobs.delete(id);
}
function clearFinished() {
  for (const [id, j] of jobs) if (['done', 'error', 'cancelled'].includes(j.status)) jobs.delete(id);
}
function openFile(id) { const j = jobs.get(id); if (j && j.file) shell.openPath(j.file); }
function showFile(id) {
  const j = jobs.get(id);
  if (j && j.file && fs.existsSync(j.file)) shell.showItemInFolder(j.file);
  else shell.openPath(settings.get('downloadDir'));
}

function run(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(ytdlpPath(), args, { windowsHide: true, timeout, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() }));
  });
}
async function version() { const r = await run(['--version'], 20000); return r.ok ? r.out : t('s.dl.notFound'); }
async function selfUpdate() {
  const r = await run(['-U'], 180000);
  return { ok: r.ok, message: (r.out + '\n' + r.err).trim().split('\n').slice(-3).join('\n'), version: await version() };
}
function activeCount() {
  return [...jobs.values()].filter((j) => ACTIVE.includes(j.status) || j.status === 'queued').length;
}
function killAll() { for (const j of jobs.values()) if (ACTIVE.includes(j.status) || j.status === 'queued') cancel(j.id); }

// Mise à jour automatique quotidienne de yt-dlp (YouTube change souvent, les vieilles versions se font bloquer)
async function autoUpdate() {
  const last = settings.get('ytdlpLastUpdate') || 0;
  if (Date.now() - last < 24 * 3600 * 1000) return;
  const r = await selfUpdate();
  if (r.ok) settings.set('ytdlpLastUpdate', Date.now());
}

module.exports = { init, setTranslator, start, retry, autoUpdate, cancel, remove, clearFinished, list, openFile, showFile, version, selfUpdate, activeCount, killAll };
