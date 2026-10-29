# DSH Bridge — 前景啟動本機接收端（127.0.0.1:8765）
# 用法：在 PowerShell 執行 .\start-bridge.ps1（看即時輸出，Ctrl+C 停止）
# 平常不需要這支：背景常駐請用 .\ensure-bridge.ps1（沒跑就起來）
# 開機自動啟動請用 .\install-autostart.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$python = $null
foreach ($cand in @(
    "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
)) {
    if (Test-Path $cand) { $python = $cand; break }
}
if (-not $python) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source }
}
if (-not $python) {
    Write-Error "找不到 python，請先安裝 Python 3，或修改此腳本內的 python 路徑。"
}

Write-Host "使用 Python: $python"
Write-Host "啟動 DSH Bridge server ... (Ctrl+C 停止)"
& $python "$here\bridge_server.py" @args
