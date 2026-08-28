// 磁盘清理 IPC（空间检测 / 垃圾扫描 / 清理 / 大文件查找）
const { ipcMain, shell } = require('electron');
const { exec } = require('child_process');
const { runPs } = require('./net-ipc');

// 扫描：磁盘空间 + 各类垃圾大小（无需管理员）
const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
function SizeOf($p) {
  if (Test-Path $p) {
    $s = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum -ErrorAction SilentlyContinue).Sum
    if ($null -eq $s) { $s = 0 }
    return [math]::Round([double]$s / 1MB, 1)
  }
  return 0
}
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
  @{ drive = $_.DeviceID; free = [math]::Round($_.FreeSpace / 1GB, 1); total = [math]::Round($_.Size / 1GB, 1) }
})
$defs = @(
  @{ name = '用户临时文件'; path = $env:TEMP; needAdmin = $false; kind = 'folder' },
  @{ name = 'Windows临时文件'; path = "$env:WINDIR\\Temp"; needAdmin = $true; kind = 'folder' },
  @{ name = '缩略图/图标缓存'; path = "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer"; needAdmin = $false; kind = 'thumb' },
  @{ name = 'Chrome 缓存'; path = "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Cache"; needAdmin = $false; kind = 'folder' },
  @{ name = 'Edge 缓存'; path = "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\Default\\Cache"; needAdmin = $false; kind = 'folder' },
  @{ name = 'Windows 更新缓存'; path = "$env:WINDIR\\SoftwareDistribution\\Download"; needAdmin = $true; kind = 'folder' },
  @{ name = '预读取 Prefetch'; path = "$env:WINDIR\\Prefetch"; needAdmin = $true; kind = 'folder' }
)
$out = @()
foreach ($d in $defs) {
  $out += @{ name = $d.name; path = $d.path; sizeMB = (SizeOf $d.path); needAdmin = $d.needAdmin; kind = $d.kind; exists = (Test-Path $d.path) }
}
@{ ok = $true; drives = @($drives); categories = @($out) } | ConvertTo-Json -Compress -Depth 5
`;

// 清理（提权）：删除选中分类内容 + 清空回收站
function cleanScript(items) {
  const safe = (items || []).map(it => ({
    name: String(it.name || '').replace(/'/g, "''"),
    path: String(it.path || '').replace(/'/g, "''"),
    kind: it.kind === 'thumb' ? 'thumb' : 'folder'
  }));
  const json = JSON.stringify(safe);
  return `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = '__LOG__'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$items = @(ConvertFrom-Json '${json}')
$freed = 0
$done = @()
foreach ($it in $items) {
  try {
    $p = $it.path
    if (Test-Path $p) {
      $before = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum -ErrorAction SilentlyContinue).Sum
      if ($null -eq $before) { $before = 0 }
      if ($it.kind -eq 'thumb') {
        Get-ChildItem $p -Filter 'thumbcache_*.db' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem $p -Filter 'iconcache_*.db' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      } else {
        Get-ChildItem $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      }
      $freed += [double]$before
      $done += [string]$it.name
    }
  } catch { }
}
try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue; $done += '回收站' } catch { }
$json = @{ ok = $true; freedMB = [math]::Round($freed / 1MB, 1); done = @($done) } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($log, $json, $utf8)
Write-Output $json
`;
}

// 大文件查找（无需管理员）
function bigFilesScript(folder, minMB) {
  const f = (folder || '$env:USERPROFILE\\Downloads').replace(/'/g, "''");
  const m = parseInt(minMB, 10) || 100;
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$folder = '${f}'
if ($folder -eq '') { $folder = "$env:USERPROFILE\\Downloads" }
if (-not (Test-Path $folder)) { @{ ok = $false; error = '路径不存在' } | ConvertTo-Json -Compress; exit }
$files = @(Get-ChildItem $folder -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt (${m} * 1MB) } | Sort-Object Length -Descending | Select-Object -First 30 | ForEach-Object {
  @{ name = $_.Name; path = $_.FullName; sizeMB = [math]::Round($_.Length / 1MB, 1) }
})
@{ ok = $true; folder = $folder; files = @($files) } | ConvertTo-Json -Compress -Depth 4
`;
}

function register() {
  ipcMain.handle('disk:scan', () => runPs(SCAN_SCRIPT, false));
  ipcMain.handle('disk:clean', (e, { items }) => runPs(cleanScript(items), true));
  ipcMain.handle('disk:bigFiles', (e, { folder, minMB }) => runPs(bigFilesScript(folder, minMB), false));
  ipcMain.handle('disk:showInFolder', (e, p) => { if (p) shell.showItemInFolder(p); });
  ipcMain.handle('disk:cleanmgr', () => new Promise(resolve => {
    exec('cleanmgr', (err) => resolve({ ok: !err }));
  }));
}

module.exports = { register };
