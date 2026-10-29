<#
  確保 DSH Bridge 在跑（127.0.0.1:8765）。

  - 已經在跑 → 直接回報狀態
  - 沒在跑   → 用 pythonw 在背景啟動「守護程式」(bridge_daemon.py)，
              它會把 server 顧好（掛掉自動重開）
  - 卡住或要換新版 → 加 -Restart，先殺掉舊的 server/守護程式再開

  用法：
    powershell -ExecutionPolicy Bypass -File .\ensure-bridge.ps1
    powershell -ExecutionPolicy Bypass -File .\ensure-bridge.ps1 -Restart
#>
param([switch]$Restart)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

function Get-BridgeHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 }
    catch { return $null }
}

function Find-Python([string]$exeName) {
    $cands = @(
        (Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\$exeName"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\$exeName"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\$exeName"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\$exeName")
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command $exeName -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command ($exeName -replace 'w\.exe$', '.exe') -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-BridgeProcs {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -in @("python.exe", "pythonw.exe") -and $_.CommandLine -and
            ($_.CommandLine -like "*bridge_server.py*" -or $_.CommandLine -like "*bridge_daemon.py*")
        }
}

function Wait-Bridge([int]$tries = 30) {
    for ($i = 0; $i -lt $tries; $i++) {
        Start-Sleep -Milliseconds 300
        $h = Get-BridgeHealth
        if ($h) { return $h }
    }
    return $null
}

if ($Restart) {
    Get-BridgeProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 700
}

$health = Get-BridgeHealth
if ($health) {
    Write-Host "bridge 已在執行（v$($health.version)，已連線瀏覽器：$(@($health.clients).Count)）"
    exit 0
}

$pythonw = Find-Python "pythonw.exe"
if (-not $pythonw) { $pythonw = Find-Python "python.exe" }
if (-not $pythonw) {
    Write-Error "找不到 python / pythonw，請先安裝 Python 3，或修改 ensure-bridge.ps1 的路徑。"
}

$daemon = Join-Path $here "bridge_daemon.py"
$daemonRunning = @(Get-BridgeProcs | Where-Object { $_.CommandLine -like "*bridge_daemon.py*" }).Count -gt 0

if (-not $daemonRunning -and (Test-Path $daemon)) {
    Write-Host "啟動 bridge 守護程式：$pythonw $daemon"
    Start-Process -FilePath $pythonw -ArgumentList @($daemon) -WorkingDirectory $here -WindowStyle Hidden
} elseif (-not $daemonRunning) {
    Write-Host "啟動 bridge server（沒有守護程式）：$pythonw"
    Start-Process -FilePath $pythonw `
        -ArgumentList @((Join-Path $here "bridge_server.py")) `
        -WorkingDirectory $here -WindowStyle Hidden
}

$health = Wait-Bridge
if ($health) {
    Write-Host "bridge 已啟動（v$($health.version)）"
    exit 0
}

Write-Error "bridge 啟動失敗，請看 $(Join-Path (Split-Path -Parent $here) 'data\bridge.log')"
exit 1
