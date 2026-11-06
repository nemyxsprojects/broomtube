// Télécharge yt-dlp.exe, ffmpeg.exe et ffprobe.exe dans ./bin (utilisés par le downloader intégré).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip';

async function download(url, dest) {
  console.log(`-> ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`   ${(buf.length / 1048576).toFixed(1)} Mo -> ${dest}`);
}

(async () => {
  fs.mkdirSync(BIN, { recursive: true });
  const force = process.argv.includes('--force');

  const ytdlp = path.join(BIN, 'yt-dlp.exe');
  if (force || !fs.existsSync(ytdlp)) await download(YTDLP_URL, ytdlp);
  else console.log('yt-dlp.exe déjà présent');

  const ffmpeg = path.join(BIN, 'ffmpeg.exe');
  const ffprobe = path.join(BIN, 'ffprobe.exe');
  if (force || !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-ffmpeg-'));
    const zip = path.join(tmp, 'ffmpeg.zip');
    await download(FFMPEG_URL, zip);
    // tar (bsdtar) est fourni avec Windows 10+ et sait extraire les .zip
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
    const find = (dir, name) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = find(p, name); if (r) return r; }
        else if (e.name.toLowerCase() === name) return p;
      }
      return null;
    };
    const ffExe = find(tmp, 'ffmpeg.exe');
    if (!ffExe) throw new Error("ffmpeg.exe introuvable dans l'archive");
    const ffBin = path.dirname(ffExe);
    for (const f of fs.readdirSync(ffBin)) {
      if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(f)) fs.copyFileSync(path.join(ffBin, f), path.join(BIN, f));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('ffmpeg/ffprobe extraits');
  } else console.log('ffmpeg/ffprobe déjà présents');
})().catch((e) => { console.error(e); process.exit(1); });
