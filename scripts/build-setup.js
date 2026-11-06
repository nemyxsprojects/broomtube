// Compile l'installeur Inno Setup à partir de dist/win-unpacked.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const source = path.join(root, 'dist', 'win-unpacked');

if (!fs.existsSync(path.join(source, `${pkg.productName}.exe`))) {
  console.error(`Build introuvable dans ${source}. Lance d'abord "npm run pack".`);
  process.exit(1);
}

const candidates = [
  process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean);
const iscc = candidates.find((p) => fs.existsSync(p));
if (!iscc) {
  console.error('ISCC.exe (Inno Setup 6) introuvable. Installe-le : winget install JRSoftware.InnoSetup');
  process.exit(1);
}

console.log(`Inno Setup : ${iscc}`);
execFileSync(iscc, [
  `/DAppVersion=${pkg.version}`,
  `/DSourceDir=${source}`,
  path.join(root, 'installer', 'BroomTube.iss'),
], { stdio: 'inherit' });
console.log(`\nInstalleur : dist\\BroomTube-Setup-${pkg.version}-x64.exe`);
