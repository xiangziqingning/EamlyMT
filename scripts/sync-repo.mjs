// sync-repo.mjs
// Update the pushed source files (existing -> PUT with sha) and re-publish
// the release assets (delete old immutable asset, upload new one).
// Run:  $env:GH_OWNER=... ; $env:GH_REPO=... ; $env:GHTOK=... ; $env:GH_VERSION=...
//       node scripts/sync-repo.mjs
import fs from 'fs'; import path from 'path'; import https from 'https'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const owner = process.env.GH_OWNER, repo = process.env.GH_REPO, token = process.env.GHTOK;
const version = (process.env.GH_VERSION || '1.10.0').replace(/^v/i, '');
const API = 'https://api.github.com', UP = 'https://uploads.github.com';
if (!owner || !repo || !token) { console.error('missing env'); process.exit(1); }
let failures = 0;
const log = (ok, m) => { console.log((ok ? '  ok  ' : '  FAIL ') + m); if (!ok) failures++; };
function req(method, url, { json = null, raw = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const body = raw ? raw : (json ? Buffer.from(JSON.stringify(json)) : null);
    const headers = { Authorization: 'Bearer ' + token, 'User-Agent': 'ws-sync', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = body.length; }
    const r = https.request(u, { method, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const BRANCH = 'main';

// ---- update/add source files ----
const FILES = ['update-ipc.js', 'scripts/stage-release.ps1', 'scripts/verify-update.mjs', 'scripts/github-release.mjs', 'scripts/sync-repo.mjs'];
console.log('--- sync source files ---');
for (const f of FILES) {
  const local = path.join(root, f);
  if (!fs.existsSync(local)) { continue; }
  const content = fs.readFileSync(local).toString('base64');
  const url = `${API}/repos/${owner}/${repo}/contents/${f.split('/').map(encodeURIComponent).join('/')}`;
  const cur = await req('GET', url + '?ref=' + BRANCH);
  const body = { message: 'sync ' + f, content, branch: BRANCH };
  if (cur.status === 200) body.sha = JSON.parse(cur.body).sha; // existing -> need sha
  const put = await req('PUT', url, { json: body });
  log(true, f + (cur.status === 200 ? ' (updated)' : ' (added)') + ' [' + put.status + ']');
}

// ---- re-publish release assets ----
console.log('--- re-publish assets ---');
const rel = await req('GET', `${API}/repos/${owner}/${repo}/releases/tags/v${version}`);
let relId = null, uploadUrl = null;
if (rel.status === 200) { const r = JSON.parse(rel.body); relId = r.id; uploadUrl = r.upload_url; log(true, 'found release id=' + relId); }
else { log(false, 'release not found: ' + rel.status); process.exit(1); }
const assets = await req('GET', `${API}/repos/${owner}/${repo}/releases/${relId}/assets`);
if (assets.status !== 200) { log(false, 'list assets ' + assets.status); process.exit(1); }
const oldAssets = JSON.parse(assets.body);
const want = ['workstation-' + version + '.asar', 'latest.json'];
const srcDir = path.join(root, '_release');
const upload = async (name) => {
  const pathName = path.join(srcDir, name);
  if (!fs.existsSync(pathName)) { log(false, name + ' (missing)'); return; }
  const data = fs.readFileSync(pathName);
  const base = uploadUrl.replace(/\{[^}]*\}/g, '');
  const res = await req('POST', base + '?name=' + encodeURIComponent(name), { raw: data, contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  log(true, 'uploaded ' + name + ' (' + data.length + 'B) [' + res.status + ']');
};
for (const name of want) {
  const old = oldAssets.find(a => a.name === name);
  if (old) { const d = await req('DELETE', `${API}/repos/${owner}/${repo}/releases/assets/${old.id}`); log(true, 'deleted old ' + name + ' [' + d.status + ']'); }
  await upload(name);
}
console.log('\n========== sync done, failures=' + failures + ' ==========');
process.exit(failures > 0 ? 1 : 0);
