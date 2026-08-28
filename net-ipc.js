// 网络工具箱 IPC 处理器（DNS 测速 / 网站延迟 / 节点延迟 / 一键切换系统 DNS）
const { ipcMain, clipboard } = require('electron');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 运行 PowerShell 脚本；elevated=true 时通过 UAC 提权
function runPs(script, elevated) {
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), 'ws-net-' + Date.now() + '.ps1');
    const log = tmp + '.json';
    try { fs.writeFileSync(tmp, '\uFEFF' + script.replace('__LOG__', log), 'utf8'); }
    catch (e) { resolve({ ok: false, error: '无法写入脚本: ' + String(e) }); return; }
    try { fs.rmSync(log, { force: true }); } catch {}

    const cleanup = () => { try { fs.rmSync(tmp, { force: true }); fs.rmSync(log, { force: true }); } catch {} };
    let child;
    if (elevated) {
      const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"' + tmp + '"'].join(' ');
      child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell.exe -ArgumentList '${inner}' -Verb RunAs -Wait`], { windowsHide: false });
    } else {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { windowsHide: true });
    }
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
    child.on('close', () => {
      clearTimeout(timer);
      if (elevated) {
        const waitFor = (attempts) => {
          if (fs.existsSync(log)) {
            let result = null;
            try { result = JSON.parse(fs.readFileSync(log, 'utf8').replace(/^\uFEFF/, '')); } catch {}
            cleanup();
            resolve(result || { ok: false, error: '无法解析结果' });
          } else if (attempts > 0) {
            setTimeout(() => waitFor(attempts - 1), 300);
          } else {
            cleanup();
            resolve({ ok: false, error: '未收到结果（可能取消了管理员授权）' });
          }
        };
        waitFor(100);
      } else {
        let result = null;
        try { result = JSON.parse(out.trim()); } catch {}
        cleanup();
        resolve(result || { ok: false, error: err.trim() || '脚本执行失败' });
      }
    });
  });
}

// 读取当前系统 DNS（无需管理员）
const CURRENT_SCRIPT = `
$rows = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | ForEach-Object {
  @{ alias = $_.InterfaceAlias; index = $_.InterfaceIndex; servers = @($_.ServerAddresses) }
})
@{ ok = $true; rows = @($rows) } | ConvertTo-Json -Compress -Depth 5
`;

// 一键应用 DNS（提权）：找默认路由网卡 → 备份旧 DNS → 写入新 DNS → 刷新缓存
function applyScript(primary, backup) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = '__LOG__'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
  if ($route) { $idx = [int]$route.InterfaceIndex }
  else {
    $ad = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
    $idx = [int]$ad.ifIndex
  }
  $alias = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name
  $cur = @(Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ServerAddresses)
  Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses @('${primary}','${backup}')
  ipconfig /flushdns | Out-Null
  $json = @{ ok = $true; index = $idx; alias = $alias; previous = @($cur) } | ConvertTo-Json -Compress
  Write-Output $json
  [System.IO.File]::WriteAllText($log, $json, $utf8)
} catch {
  $json = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  Write-Output $json
  [System.IO.File]::WriteAllText($log, $json, $utf8)
}
`;
}

// 恢复 DNS（提权）
function restoreScript(servers) {
  const list = (servers && servers.length ? servers : ['223.5.5.5']).map(s => "'" + s + "'").join(',');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = '__LOG__'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
  if ($route) { $idx = [int]$route.InterfaceIndex }
  else {
    $ad = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
    $idx = [int]$ad.ifIndex
  }
  $alias = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name
  Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses @(${list})
  ipconfig /flushdns | Out-Null
  $json = @{ ok = $true; index = $idx; alias = $alias } | ConvertTo-Json -Compress
  Write-Output $json
  [System.IO.File]::WriteAllText($log, $json, $utf8)
} catch {
  $json = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  Write-Output $json
  [System.IO.File]::WriteAllText($log, $json, $utf8)
}
`;
}

// ping 脚本（Test-Connection 解析平均延迟与丢包）
function pingScript(host, count) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$h = '${host}'
$c = ${count}
$r = Test-Connection -ComputerName $h -Count $c -ErrorAction SilentlyContinue
$times = @($r | ForEach-Object { $_.ResponseTime })
$recv = $times.Count
$loss = if ($c -gt 0) { [math]::Round(($c - $recv) / $c * 100) } else { 100 }
$avg = if ($recv -gt 0) { [math]::Round(($times | Measure-Object -Average).Average, 1) } else { -1 }
$min = if ($recv -gt 0) { [math]::Round(($times | Measure-Object -Minimum).Minimum, 1) } else { -1 }
$max = if ($recv -gt 0) { [math]::Round(($times | Measure-Object -Maximum).Maximum, 1) } else { -1 }
@{ ok = $true; host = $h; sent = $c; recv = $recv; loss = $loss; avg = $avg; min = $min; max = $max } | ConvertTo-Json -Compress
`;
}

function register() {
  // 复制文本到剪贴板
  ipcMain.handle('net:copy', (e, t) => {
    clipboard.writeText(t || '');
    return { ok: true };
  });

  // 刷新 DNS 缓存（需要管理员权限）
  ipcMain.handle('net:flushDns', () => new Promise(resolve => {
    exec('ipconfig /flushdns', { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || stderr || String(err || '')).trim() });
    });
  }));

  // 打开网络适配器设置
  ipcMain.handle('net:openNcpa', () => new Promise(resolve => {
    exec('control ncpa.cpl', (err) => resolve({ ok: !err }));
  }));

  // 读取当前系统 DNS
  ipcMain.handle('net:getCurrentDns', () => runPs(CURRENT_SCRIPT, false));

  // 一键应用最快 DNS（UAC 提权）
  ipcMain.handle('net:applyFastDns', (e, { primary, backup }) => runPs(applyScript(primary, backup), true));

  // Wi-Fi 信号检测
  ipcMain.handle('net:wifiInfo', () => new Promise(resolve => {
    exec('netsh wlan show interfaces', { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout || !stdout.includes('SSID')) {
        resolve({ ok: false, error: '未检测到 Wi-Fi（可能正使用有线连接）' });
        return;
      }
      const get = (key) => {
        const m = stdout.match(new RegExp('[\\s\\S]*?' + key + '\\s*:\\s*([^\\r\\n]+)'));
        return m ? m[1].trim() : '';
      };
      resolve({
        ok: true,
        ssid: get('SSID 名称') || get('SSID'),
        signal: get('信号') || get('Signal'),
        rate: get('接收速率') || get('接收速度') || get('Receive rate'),
        channel: get('信道') || get('Channel')
      });
    });
  }));

  // 默认网关
  ipcMain.handle('net:gateway', () => runPs(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$gw = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
if ($gw) { @{ ok = $true; gateway = [string]$gw.NextHop; index = [int]$gw.InterfaceIndex } | ConvertTo-Json -Compress }
else { @{ ok = $false; error = '找不到默认路由' } | ConvertTo-Json -Compress }
`, false));

  // 延迟/丢包测试
  ipcMain.handle('net:ping', (e, { host, count }) => runPs(pingScript(host, count || 5), false));

  // 网速测试：定时下载计字节（腾讯 CDN，国内快）
  ipcMain.handle('net:speedTest', (e, { seconds }) => {
    const dur = (seconds || 4) * 1000;
    return new Promise(resolve => {
      const url = 'https://dldir1.qq.com/weixin/Windows/WeChatSetup.exe';
      const req = https.get(url, { timeout: 15000 }, (res) => {
        let bytes = 0;
        let finished = false;
        const start = Date.now();
        const finish = () => {
          if (finished) return;
          finished = true;
          const secs = (Date.now() - start) / 1000 || 1;
          const mbps = bytes / 1048576 / secs;
          resolve({ ok: true, mbps: Math.round(mbps * 100) / 100, seconds: Math.round(secs), bytes });
        };
        res.on('data', d => { bytes += d.length; });
        res.on('end', finish);
        setTimeout(finish, dur);
      });
      req.on('error', (err) => resolve({ ok: false, error: err.code || '测速失败' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    });
  });

  // 恢复原 DNS（UAC 提权）
  ipcMain.handle('net:restoreDns', (e, { servers }) => runPs(restoreScript(servers), true));

  // DNS 服务器测速：逐个解析同一域名，比较耗时
  ipcMain.handle('net:dnsTest', (e, { servers, domain }) => {
    const orig = dns.getServers();
    const dom = domain || 'www.baidu.com';
    function one(ip) {
      return new Promise(resolve => {
        const start = Date.now();
        let done = false;
        dns.setServers([ip]);
        const t = setTimeout(() => {
          if (!done) { done = true; dns.setServers(orig); resolve({ ip, ms: -1, error: '超时' }); }
        }, 3000);
        dns.resolve4(dom, (err) => {
          if (done) return;
          done = true; clearTimeout(t);
          const ms = Date.now() - start;
          dns.setServers(orig);
          resolve(err ? { ip, ms, error: '解析失败' } : { ip, ms });
        });
      });
    }
    return (async () => {
      const out = [];
      for (const ip of servers || []) out.push(await one(ip));
      return out;
    })();
  });

  // 常用网站延迟：HTTP(S) 请求，测量到响应头的时间
  ipcMain.handle('net:httpLatency', (e, { targets }) => {
    function one(t) {
      return new Promise(resolve => {
        const url = t.url || ('https://' + t.host);
        const mod = url.startsWith('https') ? https : http;
        const start = Date.now();
        const req = mod.get(url, { timeout: 6000 }, (res) => {
          resolve({ name: t.name, host: t.host, ms: Date.now() - start, status: res.statusCode });
          res.destroy();
        });
        req.on('timeout', () => { req.destroy(); resolve({ name: t.name, host: t.host, ms: -1, error: '超时' }); });
        req.on('error', (err) => { resolve({ name: t.name, host: t.host, ms: -1, error: err.code || '失败' }); });
      });
    }
    return (async () => {
      const out = [];
      for (const t of targets || []) out.push(await one(t));
      return out;
    })();
  });

  // 游戏/自定义节点延迟：TCP 连接耗时近似
  ipcMain.handle('net:tcpPing', (e, { targets }) => {
    function one(t) {
      return new Promise(resolve => {
        const start = Date.now();
        const sock = net.createConnection({ host: t.host, port: t.port || 443 });
        const t2 = setTimeout(() => { sock.destroy(); resolve({ name: t.name, host: t.host, port: t.port || 443, ms: -1, error: '超时' }); }, 4000);
        sock.once('connect', () => {
          clearTimeout(t2);
          resolve({ name: t.name, host: t.host, port: t.port || 443, ms: Date.now() - start });
          sock.destroy();
        });
        sock.once('error', (err) => {
          clearTimeout(t2);
          resolve({ name: t.name, host: t.host, port: t.port || 443, ms: -1, error: err.code || '失败' });
        });
      });
    }
    return (async () => {
      const out = [];
      for (const t of targets || []) out.push(await one(t));
      return out;
    })();
  });
}

module.exports = { register, runPs, applyScript, restoreScript };
