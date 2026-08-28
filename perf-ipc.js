// 游戏性能优化 IPC（状态检测 / 一键优化 / 还原）
const { ipcMain } = require('electron');
const { runPs } = require('./net-ipc');

// 系统状态检测（无需管理员）
const STATUS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
$gpu = @((Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name } | ForEach-Object { $_.Name }) -join ' / ')
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).TotalPhysicalMemory / 1GB, 1)
$free = [math]::Round((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).FreePhysicalMemory / 1MB, 1)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object { @{ drive = $_.DeviceID; free = [math]::Round($_.FreeSpace / 1GB, 1); total = [math]::Round($_.Size / 1GB, 1) } })
$procs = @(Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 | ForEach-Object { @{ name = $_.ProcessName; mem = [math]::Round($_.WorkingSet64 / 1MB) } })
$plan = ''
$planLine = powercfg /getactivescheme 2>$null
if ($planLine -match '\\((.*?)\\)') { $plan = $matches[1] }
@{ ok = $true; cpu = [string]$cpu; gpu = [string]$gpu; ram = $ram; freeRam = $free; disks = @($disks); procs = @($procs); plan = [string]$plan } | ConvertTo-Json -Compress -Depth 5
`;

// 一键优化（提权）：高性能电源 + 关 Game DVR + 关全屏优化 + 关动画
function applyScript() {
  return `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = '__LOG__'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$backup = @{}
$changed = @()
try {
  $cur = powercfg /getactivescheme
  if ($cur -match '\\{([0-9a-fA-F\\-]+)\\}') { $backup.plan = $matches[1] }
  powercfg /setactive SCHEME_MIN | Out-Null
  $changed += '电源计划(高性能)'
} catch { $backup.planError = $_.Exception.Message }
$items = @(
  @{ p = 'HKCU:\\System\\GameConfigStore'; n = 'GameDVR_Enabled'; v = 0 },
  @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR'; n = 'AppCaptureEnabled'; v = 0 },
  @{ p = 'HKCU:\\System\\GameConfigStore'; n = 'GameDVR_FSEBehaviorMode'; v = 2 },
  @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects'; n = 'VisualFXSetting'; v = 2 }
)
foreach ($it in $items) {
  try {
    if (-not (Test-Path $it.p)) { New-Item -Path $it.p -Force | Out-Null }
    $old = (Get-ItemProperty -Path $it.p -Name $it.n -ErrorAction SilentlyContinue).$it.n
    $backup[$it.n] = $old
    Set-ItemProperty -Path $it.p -Name $it.n -Value $it.v -Type DWord
    $changed += $it.n
  } catch { }
}
$json = @{ ok = $true; changed = @($changed); backup = $backup } | ConvertTo-Json -Compress -Depth 5
[System.IO.File]::WriteAllText($log, $json, $utf8)
Write-Output $json
`;
}

// 还原（提权）：恢复注册表原值 + 原电源计划
function restoreScript(backupJson) {
  const safe = (backupJson || '{}').replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = '__LOG__'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$backup = ConvertFrom-Json '${safe}'
$restored = @()
$items = @(
  @{ p = 'HKCU:\\System\\GameConfigStore'; n = 'GameDVR_Enabled' },
  @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR'; n = 'AppCaptureEnabled' },
  @{ p = 'HKCU:\\System\\GameConfigStore'; n = 'GameDVR_FSEBehaviorMode' },
  @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects'; n = 'VisualFXSetting' }
)
foreach ($it in $items) {
  $v = $backup.($it.n)
  try {
    if ($null -eq $v) { Remove-ItemProperty -Path $it.p -Name $it.n -ErrorAction SilentlyContinue }
    else { Set-ItemProperty -Path $it.p -Name $it.n -Value $v -Type DWord }
    $restored += $it.n
  } catch { }
}
if ($backup.plan) { try { powercfg /setactive $backup.plan | Out-Null; $restored += '电源计划' } catch { } }
$json = @{ ok = $true; restored = @($restored) } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($log, $json, $utf8)
Write-Output $json
`;
}

function register() {
  ipcMain.handle('perf:status', () => runPs(STATUS_SCRIPT, false));
  ipcMain.handle('perf:apply', () => runPs(applyScript(), true));
  ipcMain.handle('perf:restore', (e, { backup }) => runPs(restoreScript(JSON.stringify(backup || {})), true));
}

module.exports = { register };
