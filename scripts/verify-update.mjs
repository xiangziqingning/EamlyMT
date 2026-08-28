// verify-update.mjs
// Exercises the REAL update-ipc.js (the code the app runs) against the live repo:
//   fetchLatestManifest() -> latest.json parse
//   downloadResume() -> asar download + sha512 verify (the "不能断链" path)
// Run:
//   $env:GH_OWNER=... ; $env:GH_REPO=... ; node scripts/verify-update.mjs
import os from 'os'; import path from 'path'; import fs from 'fs'; import Module from 'module';
import { fileURLToPath } from 'url'; import { createRequire } from 'module';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const orig = Module._load;
Module._load = function (req) { if (req === 'electron') return { app: { getAppPath: () => '', getPath: () => os.tmpdir(), getVersion: () => '1.10.0', relaunch: () => {}, exit: () => {} }, ipcMain: { handle: () => {} } }; return orig.apply(this, arguments); };
const req = createRequire(import.meta.url);
const updater = req(path.join(root, 'update-ipc.js'));
const I = updater._internals;
updater.loadConfig();
updater.cfg.owner = process.env.GH_OWNER || 'xiangziqingning';
updater.cfg.repo = process.env.GH_REPO || 'EamlyMT';

console.log('checking repo: ' + updater.cfg.owner + '/' + updater.cfg.repo);
const man = await I.fetchLatestManifest();
console.log('manifest version =', man.version, '| release =', man.releaseUrl);
console.log('files =', JSON.stringify(man.files.map(f => ({ name: f.name, size: f.size, hasUrl: !!f.url }))));
const file = man.files.find(f => /\.asar$/i.test(f.name));
if (!file) throw new Error('no asar in manifest');
console.log('\ndownloading ' + file.name + ' with sha512 verify...');
const dest = path.join(os.tmpdir(), 'verify-' + Date.now() + '.asar');
const res = await I.downloadResume(file.url, dest, { sha512: file.sha512 });
const bytes = fs.statSync(dest).size;
console.log('downloaded bytes =', bytes, '| verified sha512 =', res.size === file.size && bytes === file.size);
fs.rmSync(dest, { force: true });
console.log('\nRESULT: OK — the app can fetch latest.json and download+verify the asar from GitHub on this network.');
