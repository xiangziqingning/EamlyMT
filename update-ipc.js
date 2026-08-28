// ============================================================
// 自动更新器（自定义，GitHub Releases 方案）
// 通过 GitHub Releases API 检查最新版本，下载 app.asar 替换资源。
// 设计目标（不能断链）：
//   - 下载支持断点续传 + 重试 + 指数退避 + sha512 完整性校验
//   - 原子替换（备份 + 回滚），任何一步失败都不毁坏当前版本
//   - 连接错误静默捕获，绝不崩溃，稍后自动重试
//   - 后台轮询，不占用/不干扰网络工具箱等其它 IPC
// ============================================================
const { app, ipcMain } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- 配置 ----------
// 默认从打包的 update-config.json（放在 exe 同目录）读取，
// 也允许通过环境变量覆盖，便于 CI / 调试。
const DEFAULT_CONFIG = {
  owner: '<你的GitHub用户名>',      // 必填：GitHub 用户名/组织
  repo: 'workstation-app',          // 必填：仓库名（需与上传到的仓库一致）
  apiBase: 'https://api.github.com',
  checkIntervalMs: 4 * 60 * 60 * 1000,   // 每 4 小时检查一次
  assetName: 'latest.json',             // 版本清单资产名
  appAssetSuffix: '.asar',              // 应用包资产后缀
  timeoutMs: 20000,
  maxRetries: 3,
  backupCount: 2                        // 保留的历史备份点数
};

let cfg = Object.assign({}, DEFAULT_CONFIG);

function loadConfig() {
  // 1) exe 同目录的 update-config.json 覆盖（用户无需重新打包即可改）
  try {
    const exeDir = path.dirname(process.execPath);
    const f = path.join(exeDir, 'update-config.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg = Object.assign({}, cfg, j);
    }
  } catch (e) { /* ignore, 用默认值 */ }
  // 2) 环境变量覆盖（CI/调试）
  if (process.env.WORKSTATION_UPDATE_OWNER) cfg.owner = process.env.WORKSTATION_UPDATE_OWNER;
  if (process.env.WORKSTATION_UPDATE_REPO) cfg.repo = process.env.WORKSTATION_UPDATE_REPO;
  if (process.env.WORKSTATION_UPDATE_API) cfg.apiBase = process.env.WORKSTATION_UPDATE_API;
}

// ---------- 版本 ----------
let pkgVersion = null;
function currentVersion() {
  if (pkgVersion) return pkgVersion;
  try {
    // 打包后 package.json 随 asar 打包进来（与 update-ipc.js 同级）
    pkgVersion = require('./package.json').version;
  } catch (e) {
    try { pkgVersion = app.getVersion(); } catch (e2) { pkgVersion = '1.0.0'; }
  }
  return String(pkgVersion || '1.0.0');
}

function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}
function isNewer(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  for (let i = 0; i < 3; i++) { if (A[i] > B[i]) return true; if (A[i] < B[i]) return false; }
  return false;
}

// ---------- 基础 HTTP ----------
const UA = 'workstation-updater/1.0';

// 带重定向的 GET，返回 res 流
function httpsGet(url, opts = {}) {
  const { headers = {}, timeout = cfg.timeoutMs, redirects = 5, method = 'GET' } = opts;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method, headers: Object.assign({ 'User-Agent': UA }, headers), timeout }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve(httpsGet(next, Object.assign({}, opts, { redirects: redirects - 1 })));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    // http.request 不会自动发送请求，必须调用 end()；GET 无请求体
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

async function getJson(url, opts = {}) {
  const res = await httpsGet(url, Object.assign({
    headers: { 'Accept': 'application/vnd.github+json' }
  }, opts));
  const body = await readBody(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + (body ? ' ' + body.slice(0, 200) : ''));
  }
  return JSON.parse(body.replace(/^\uFEFF/, '')); // 去掉可能的 BOM
}

// 带重试的 JSON 请求（指数退避）
async function getJsonRetry(url, opts = {}, retries = cfg.maxRetries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await getJson(url, opts); }
    catch (e) {
      lastErr = e;
      if (i === retries || (e && e.message && e.message.indexOf('timeout') === 0 && i === 0)) {
        // 超时只多试一次即可，其它错误退避
      }
      await sleep(Math.min(500 * Math.pow(2, i), 6000));
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- sha512 ----------
function sha512File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(p);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ---------- 带断点续传的下载 ----------
// dest.part 为断点文件；完成后校验 sha512；支持进度回调
async function downloadResume(url, dest, { sha512 = null, onProgress = null } = {}) {
  const part = dest + '.part';
  let resume = 0;
  if (fs.existsSync(part)) { try { resume = fs.statSync(part).size; } catch (e) { resume = 0; } }

  const headers = { 'User-Agent': UA };
  if (resume > 0) headers['Range'] = 'bytes=' + resume + '-';

  const res = await httpsGet(url, { headers, timeout: cfg.timeoutMs });
  const code = res.statusCode;

  // 如果返回完整内容（200），从头写；206 表示接受断点；416 表示已完整（占位）
  if (![200, 206, 416].includes(code)) {
    res.resume();
    throw new Error('下载失败 HTTP ' + code);
  }

  if (code === 416) {
    res.resume();
    // 范围内已完整，直接进入校验
  } else if (code === 200) {
    // 服务端忽略 Range，从头开始
    resume = 0;
  }
  // 206: 追加写入

  const writeOpts = { flags: resume > 0 && code === 206 ? 'a' : 'w' };
  const dowloadStream = fs.createWriteStream(part, writeOpts);

  return new Promise((resolve, reject) => {
    let received = resume;
    let total = 0;
    if (res.headers && res.headers['content-length']) total = resume + parseInt(res.headers['content-length'], 10);
    const contentRange = res.headers && res.headers['content-range'];
    if (contentRange) { const m = contentRange.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }

    res.on('data', c => {
      received += c.length;
      if (onProgress) onProgress(received, total || 0);
    });
    res.pipe(dowloadStream);
    dowloadStream.on('finish', () => {
      dowloadStream.close(() => {
        (async () => {
          try {
            if (sha512) {
              const got = await sha512File(part);
              // 大小不够或哈希不匹配：删掉续传点重新来
              if (got.toLowerCase() !== String(sha512).toLowerCase()) {
                fs.rmSync(part, { force: true });
                reject(new Error('校验失败')); return;
              }
            }
            fs.rmSync(dest, { force: true });
            fs.renameSync(part, dest);
            resolve({ size: received });
          } catch (e) { reject(e); }
        })();
      });
    });
    dowloadStream.on('error', reject);
    res.on('error', reject);
  });
}

// ---------- 找到 app.asar 目标路径 ----------
function asarTargetPath() {
  let appPath;
  try { appPath = app.getAppPath(); } catch (e) { appPath = ''; }
  if (appPath && String(appPath).toLowerCase().endsWith('.asar') && fs.existsSync(appPath)) {
    return appPath;
  }
  // 开发/便携环境下定位 resources/app.asar
  const resources = path.join(path.dirname(process.execPath), 'resources');
  const candidate = path.join(resources, 'app.asar');
  if (fs.existsSync(candidate)) return candidate;
  // 兜底：上一级（Resources 大写目录）
  const cand2 = path.join(path.dirname(process.execPath), 'Resources', 'app.asar');
  if (fs.existsSync(cand2)) return cand2;
  return candidate;
}

// ---------- 原子替换 + 回滚 ----------
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }
async function replaceAsarAtomic(newAsar) {
  const target = asarTargetPath();
  if (!fs.existsSync(target)) throw new Error('找不到 app.asar：' + target);
  const bak = target + '.bak';
  // 备份现有（防御顺序：无论如何先留副本，失败可回滚）
  fs.rmSync(bak, { force: true });
  fs.copyFileSync(target, bak);

  // 替换：受短时文件占锁影响，尝试多次
  let done = false, lastErr = null;
  for (let attempt = 0; attempt < 4 && !done; attempt++) {
    try {
      fs.rmSync(target, { force: true });
      fs.copyFileSync(newAsar, target);
      fs.rmSync(newAsar, { force: true });
      done = true;
    } catch (e) {
      lastErr = e;
      // 若目标已丢但新包未写入，立即用备份恢复
      try { if (!fs.existsSync(target)) fs.copyFileSync(bak, target); } catch (e2) {}
      if (attempt < 3) { await sleepMs(400 * (attempt + 1)); }
    }
  }
  if (!done) {
    // 最终回滚
    try { fs.rmSync(target, { force: true }); fs.copyFileSync(bak, target); fs.rmSync(bak, { force: true }); } catch (e2) {}
    throw lastErr || new Error('替换失败');
  }
  fs.rmSync(bak, { force: true });
  return target;
}

// ---------- 获取最新版本信息 ----------
async function fetchLatestManifest() {
  if (!cfg.owner || cfg.owner.indexOf('<') === 0) {
    throw { friendly: '未配置 GitHub 仓库。请在 exe 同目录的 update-config.json 里填写 owner/repo。' };
  }
  const api = cfg.apiBase.replace(/\/$/, '');
  const releaseUrl = api + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/releases/latest';
  const rel = await getJsonRetry(releaseUrl);

  const asset = (rel.assets || []).find(a => a.name === cfg.assetName);
  if (!asset) throw new Error('发布版缺少 ' + cfg.assetName + ' 资产');
  const manText = await readBody(await httpsGet(asset.browser_download_url));
  let man;
  try { man = JSON.parse(manText.replace(/^\uFEFF/, '')); } catch (e) { throw new Error('版本清单格式错误'); }
  // 把 latest.json 里的文件名解析成真实下载地址（来自 release assets）
  const assetMap = {};
  (rel.assets || []).forEach(a => { assetMap[a.name] = a.browser_download_url; });
  const files = (Array.isArray(man.files) ? man.files : [])
    .map(f => Object.assign({}, f, { url: assetMap[f.name] }))
    .filter(f => !!f.url);
  return {
    version: man.version,
    releasedAt: man.releasedAt,
    notes: man.notes || '',
    files,
    releaseUrl: rel.html_url
  };
}

function pickWinFile(files) {
  // 优先平台明确的，否则第一个
  const f = (files || []).find(x => /win32|x64|ia32/i.test(String(x.platform || ''))) || (files || [])[0];
  return f;
}

// ---------- 状态 / 事件 ----------
let mainWindow = null;
let lastState = 'idle'; // idle | checking | available | downloading | ready | updating | upToDate | error

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}
function pushStatus(patch) {
  lastState = patch.state || lastState;
  send('upd:status', Object.assign({ state: lastState }, patch));
}

function setWindow(w) { mainWindow = w; }

// 下载目标：放进资源目录（与 app.asar 同盘，保证原子 rename 不跨卷）
function setDownloadPath(version) {
  return path.join(path.dirname(targetCacheDir()), 'workstation-' + version + '.asar.new.tmp');
}
let _cacheDir = null;
function targetCacheDir() {
  if (_cacheDir) return _cacheDir;
  // 优先 exe 同目录的子目录（可能存在权限问题时回退 userData）
  const exeDir = path.dirname(process.execPath);
  const cand = path.join(exeDir, 'updates');
  try { fs.mkdirSync(cand, { recursive: true }); return (_cacheDir = cand); } catch (e) {}
  const ud = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(ud, { recursive: true });
  return (_cacheDir = ud);
}

// ---------- 核心流程 ----------
async function check({ silent = false } = {}) {
  if (lastState === 'downloading' || lastState === 'updating') return lastResult();
  if (!silent) pushStatus({ state: 'checking', message: '正在检查更新…' });
  const current = currentVersion();
  try {
    const man = await fetchLatestManifest();
    const file = pickWinFile(man.files);
    const latest = man.version;
    const available = isNewer(latest, current);

    if (available && file) {
      lastResult = {
        state: 'available', current, latest, notes: man.notes,
        releaseUrl: man.releaseUrl,
        fileName: file.name, url: file.downloadUrl || file.url, sha512: file.sha512, size: file.size
      };
      pushStatus({ state: 'available', current, latest, notes: man.notes, releaseUrl: man.releaseUrl, hasFile: true });
    } else {
      pushStatus({ state: 'upToDate', current, latest });
    }
  } catch (e) {
    if (e && e.friendly) { pushStatus({ state: 'error', message: e.friendly }); }
    else if (!silent || lastState !== 'upToDate') {
      // 连接失败：静默，不打断用户；但记录状态
      pushStatus({ state: 'error', message: '检查更新失败：' + (e && e.message ? e.message : '网络异常，稍后重试'), transient: true });
    }
  }
  return lastResult;
}

let lastResult = null;

async function downloadAndInstall() {
  if (!lastResult || lastResult.state !== 'available' || !lastResult.url || !lastResult.sha512) {
    return { ok: false, error: '没有可用的更新，请先检查更新' };
  }
  const r = lastResult;
  pushStatus({ state: 'downloading', message: '开始下载更新…', progress: 0, percent: 0 });

  // 先落盘到缓存目录
  const cachedAsar = path.join(targetCacheDir(), r.fileName);
  let ok = false, lastErr;
  for (let attempt = 0; attempt <= cfg.maxRetries && !ok; attempt++) {
    try {
      const res = await downloadResume(r.url, cachedAsar, {
        sha512: r.sha512,
        onProgress: (received, total) => {
          const pct = total ? Math.min(100, Math.round(received / total * 100)) : 0;
          pushStatus({ state: 'downloading', message: '下载中 ' + pct + '%', progress: received, percent: pct });
        }
      });
      ok = true;
    } catch (e) {
      lastErr = e;
      pushStatus({ state: 'downloading', message: '下载中断，正在重试（' + (attempt + 1) + '/' + cfg.maxRetries + '）…', percent: 0, transient: true });
      await sleep(Math.min(1500 * Math.pow(2, attempt), 10000));
    }
  }
  if (!ok) {
    pushStatus({ state: 'error', message: '下载多次失败：' + (lastErr && lastErr.message || '未知错误'), transient: true });
    return { ok: false, error: '下载失败：' + (lastErr && lastErr.message || '未知错误') };
  }

  // 复制到资源目录（与 app.asar 同盘），再原子替换
  pushStatus({ state: 'ready', message: '校验通过，准备安装…' });
  const staging = path.join(path.dirname(asarTargetPath()), '.stage-' + Date.now() + '.asar');
  try {
    fs.copyFileSync(cachedAsar, staging);
    await replaceAsarAtomic(staging);
  } catch (e) {
    fs.rmSync(staging, { force: true });
    pushStatus({ state: 'error', message: '安装失败，已回滚到当前版本：' + e.message });
    return { ok: false, error: '安装失败：' + e.message };
  }

  pushStatus({ state: 'updating', message: '更新完成，正在重启…' });
  // 重启
  setTimeout(() => { try { app.relaunch(); app.exit(0); } catch (e) { app.relaunch(); } }, 600);
  return { ok: true, version: r.latest };
}

// ---------- IPC 注册 ----------
function register() {
  loadConfig();
  ipcMain.handle('upd:check', () => check());
  ipcMain.handle('upd:status', () => lastResult);
  ipcMain.handle('upd:downloadInstall', () => downloadAndInstall());
  ipcMain.handle('upd:currentVersion', () => currentVersion());
  ipcMain.handle('upd:config', () => ({
    owner: cfg.owner, repo: cfg.repo, configured: !(cfg.owner.indexOf('<') === 0)
  }));
}

// 后台轮询：启动后先检查一次，然后每检查周期一次；失败自动等待下个周期
function startAutoCheck() {
  setTimeout(() => { check({ silent: true }); }, 8000); // 启动后 8 秒首次检查（等窗口就绪）
  setInterval(() => { check({ silent: true }); }, cfg.checkIntervalMs);
}

module.exports = {
  register, setWindow, startAutoCheck, check, currentVersion, cfg, loadConfig,
  // 内部工具（供自测）
  _internals: { parseSemver, isNewer, sha512File, downloadResume, httpsGet, readBody, getJson, replaceAsarAtomic, asarTargetPath, fetchLatestManifest }
};
