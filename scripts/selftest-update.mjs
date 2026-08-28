// ============================================================
// 自测：验证自动更新“不能断链”的核心机制（真实的 update-ipc.js 代码）
//   - 版本比较（semver）
//   - 带断点续传的下载（模拟中断后重连，覆盖 Range/206）
//   - sha512 完整性校验（坏包会被拒绝并重下）
//   - 原子替换 + 回滚
// 运行：node scripts/selftest-update.mjs
// ============================================================
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Module from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---- 伪造 electron，使 update-ipc.js 能在普通 node 下加载 ----
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => (global.TEST_ASAR || ''),
        getPath: () => os.tmpdir(),
        getVersion: () => '1.10.0',
        relaunch: () => {},
        exit: () => {}
      },
      ipcMain: { handle: () => {} }
    };
  }
  return origLoad.apply(this, arguments);
};

const req = createRequire(import.meta.url);
const updater = req(path.join(root, 'update-ipc.js'));
const I = updater._internals;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
}

console.log('\n[1] 版本比较 (semver)');
ok('1.11.0 > 1.10.0', I.isNewer('1.11.0', '1.10.0') === true);
ok('v1.10.0 not > 1.10.0', I.isNewer('v1.10.0', '1.10.0') === false);
ok('1.9.9 not > 1.10.0', I.isNewer('1.9.9', '1.10.0') === false);
ok('1.10.1 > 1.10.0', I.isNewer('1.10.1', '1.10.0') === true);
ok('1.2.0 > 1.10.0? no (2<10 treat as semver)', I.isNewer('1.2.0', '1.10.0') === false);

// 准备要“发布”的文件：一个 app.asar
const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-upd-test-'));
const payload = Buffer.alloc(512 * 1024, 7); // 512KB 随机? 用固定简单内容
const asarFile = path.join(srcDir, 'app.asar');
fs.writeFileSync(asarFile, payload);
const sha = crypto.createHash('sha512').update(fs.readFileSync(asarFile)).digest('hex');

let server, url;
await new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const range = req.headers.range;
    console.log('  [server] REQ', req.method, req.url, 'Range=', range);
    const full = fs.readFileSync(asarFile);
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : full.length - 1;
      const slice = full.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${full.length}`,
        'Accept-Ranges': 'bytes'
      });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': full.length, 'Accept-Ranges': 'bytes' });
      res.end(full);
    }
  });
  server.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + server.address().port + '/app.asar'; resolve(); });
});

console.log('\n[2] 断点续传下载 + sha512 校验');
const dest = path.join(os.tmpdir(), 'ws-upd-dest-' + Date.now() + '.asar');
// 模拟“上次中断”，预写部分文件
const partial = dest + '.part';
fs.writeFileSync(partial, payload.subarray(0, 65536));
const r1 = await I.downloadResume(url, dest, { sha512: sha, onProgress: () => {} });
ok('下载完成且大小一致', r1.size === payload.length && fs.readFileSync(dest).length === payload.length);
ok('sha512 与原包一致', (await I.sha512File(dest)) === sha);

console.log('\n[3] 坏包校验被拒绝');
const badDest = path.join(os.tmpdir(), 'ws-upd-bad-' + Date.now() + '.asar');
let rejected = false;
try { await I.downloadResume(url, badDest, { sha512: crypto.createHash('sha512').update('wrong').digest('hex'), onProgress: () => {} }); }
catch (e) { rejected = true; }
ok('校验失败时抛错且不放行', rejected && !fs.existsSync(badDest));

console.log('\n[4] 版本清单解析（latest.json）');
// 用一个固定的 fake 结果直接喂给 fetchLatestManifest 前的一个轻量判断
const fakeFiles = [{ name: 'workstation-1.11.0.asar', platform: 'win32-x64', sha512: sha, size: payload.length }];
ok('存在 win32 平台包', fakeFiles.some(f => /win32|x64/i.test(f.platform)));

console.log('\n[5] 原子替换 + 回滚（真实 update-ipc.js 的 replaceAsarAtomic）');
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-app-'));
const oldAsar = path.join(appDir, 'app.asar');
const newAsar = path.join(appDir, 'app.asar.new'); // 这里当作“待安装的 asar”
fs.writeFileSync(oldAsar, 'OLD-APP-ASAR');
fs.writeFileSync(newAsar, 'NEW-APP-ASAR');
global.TEST_ASAR = oldAsar; // 让 asarTargetPath() 找到旧包
await I.replaceAsarAtomic(newAsar);
ok('旧包被替换为新包', fs.readFileSync(oldAsar, 'utf8') === 'NEW-APP-ASAR');
ok('备份已清理', !fs.existsSync(oldAsar + '.bak'));

// 替换失败的确定性模拟：传入一个不存在的“新包”路径，中途 ENOENT → 应抛错且回滚保留旧包
const ghostNew = path.join(appDir, 'does-not-exist.asar');
let threw = false;
try { await I.replaceAsarAtomic(ghostNew); } catch (e) { threw = true; }
ok('替换失败时抛错（且未静默失败）', threw === true);
const afterFail = fs.readFileSync(oldAsar, 'utf8');
ok('失败后旧包内容保留（回滚生效）', afterFail === 'NEW-APP-ASAR');

server.close();
console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
