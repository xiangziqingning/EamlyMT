// ============================================================
// github-release.mjs
// Create the GitHub repo, push the source, tag it, and publish a
// release with the updater assets (workstation-<ver>.asar + latest.json).
// Run:  $env:GH_OWNER=... ; $env:GH_REPO=... ; $env:GHTOK=... ; $env:GH_VERSION=...
//       node scripts/github-release.mjs
// Uses ONLY node https (works on networks where git/curl TLS is blocked).
// ============================================================
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const owner = process.env.GH_OWNER;
const repo = process.env.GH_REPO;
const token = process.env.GHTOK;
const version = (process.env.GH_VERSION || '1.10.0').replace(/^v/i, '');
const API = 'https://api.github.com';
const UP = 'https://uploads.github.com';

if (!owner || !repo || !token) { console.error('missing GH_OWNER / GH_REPO / GHTOK'); process.exit(1); }

let failures = 0;
function log(ok, msg) { console.log((ok ? '  ok  ' : '  FAIL ') + msg); if (!ok) failures++; }

function req(method, url, { json = null, raw = null, contentType = null, tok = token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = raw ? raw : (json ? Buffer.from(JSON.stringify(json)) : null);
    const headers = { Authorization: 'Bearer ' + tok, 'User-Agent': 'ws-updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = body.length; }
    const r = https.request(u, { method, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ---------- 1. ensure repo ----------
let repoInfo = null;
{
  const g = await req('GET', `${API}/repos/${owner}/${repo}`);
  if (g.status === 200) { repoInfo = JSON.parse(g.body); console.log('repo already exists: ' + repoInfo.full_name); }
  else if (g.status === 404) {
    const c = await req('POST', `${API}/user/repos`, { json: { name: repo, description: '我的工作站 - 桌面版（自更新）', private: false, auto_init: true, default_branch: 'main' } });
    if (c.status === 201) { repoInfo = JSON.parse(c.body); console.log('repo created: ' + repoInfo.full_name); }
    else { console.log('create repo FAILED status=' + c.status + ' ' + c.body.slice(0, 300)); process.exit(1); }
  } else { console.log('repo query status=' + g.status + ' ' + g.body.slice(0, 300)); process.exit(1); }
}
const BRANCH = 'main';

// ---------- 2. push source via Contents API ----------
const FILES = [
  '.gitignore',
  '.github/workflows/release.yml',
  'README-更新与发布.md',
  'api-ipc.js',
  'disk-ipc.js',
  'icon.ico',
  'index.html',
  'main.js',
  'net-ipc.js',
  'obs-ipc.js',
  'package-lock.json',
  'package.json',
  'perf-ipc.js',
  'preload.js',
  'scripts/selftest-update.mjs',
  'scripts/stage-release.ps1',
  'update-config.example.json',
  'update-ipc.js',
];
console.log('\n--- pushing source files ---');
for (const f of FILES) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { log(false, f + ' (missing on disk)'); continue; }
  const content = fs.readFileSync(p).toString('base64');
  const url = `${API}/repos/${owner}/${repo}/contents/${f.split('/').map(encodeURIComponent).join('/')}`;
  const res = await req('PUT', url, { json: { message: 'push ' + f, content, branch: BRANCH } });
  if (res.status === 201 || res.status === 200) log(true, f);
  else log(false, f + ' (HTTP ' + res.status + ' ' + res.body.slice(0, 200) + ')');
}

// ---------- 3. HEAD commit -> tag ----------
console.log('\n--- tag v' + version + ' ---');
const head = await req('GET', `${API}/repos/${owner}/${repo}/commits/${BRANCH}`);
let headSha = null;
if (head.status === 200) headSha = JSON.parse(head.body).sha;
else { console.log('get HEAD commit FAILED status=' + head.status); process.exit(1); }
log(true, 'HEAD sha=' + headSha);

const tagRef = await req('POST', `${API}/repos/${owner}/${repo}/git/refs`, { json: { ref: 'refs/tags/v' + version, sha: headSha } });
if (tagRef.status === 201) log(true, 'tag v' + version + ' created');
else log(false, 'tag v' + version + ' (HTTP ' + tagRef.status + ' ' + tagRef.body.slice(0, 200) + ')');

// ---------- 4. release ----------
console.log('\n--- create release ---');
const rel = await req('POST', `${API}/repos/${owner}/${repo}/releases`, { json: { tag_name: 'v' + version, name: '工作站 v' + version, body: '工作站桌面版 v' + version + '（自动更新基线版本）。', draft: false, prerelease: false } });
let relId = null, uploadUrl = null;
if (rel.status === 201) { const r = JSON.parse(rel.body); relId = r.id; uploadUrl = r.upload_url; log(true, 'release created id=' + relId); }
else log(false, 'release (HTTP ' + rel.status + ' ' + rel.body.slice(0, 200) + ')');

// ---------- 5. upload assets ----------
const relDir = path.join(root, '_release');
const assets = [
  { name: 'workstation-' + version + '.asar', file: path.join(relDir, 'workstation-' + version + '.asar'), ct: 'application/octet-stream' },
  { name: 'latest.json', file: path.join(relDir, 'latest.json'), ct: 'application/json' },
];
if (relId) {
  console.log('\n--- upload assets ---');
  for (const a of assets) {
    if (!fs.existsSync(a.file)) { log(false, a.name + ' (missing)'); continue; }
    const data = fs.readFileSync(a.file);
    const base = uploadUrl.replace(/\{[^}]*\}/g, '');
    const url = base + '?name=' + encodeURIComponent(a.name);
    const res = await req('POST', url, { raw: data, contentType: a.ct });
    if (res.status === 201) log(true, a.name + ' (' + data.length + ' bytes)');
    else log(false, a.name + ' (HTTP ' + res.status + ' ' + res.body.slice(0, 200) + ')');
  }
}

console.log('\n========== done, failures=' + failures + ' ==========');
process.exit(failures > 0 ? 1 : 0);
