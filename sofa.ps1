# Launch pi as the sofa orchestrator, in the current directory, in its own herdr session.
# Usage: sofa.ps1 [-Session sofa]
param([string]$Session = "sofa")
$ErrorActionPreference = "Stop"

$ext = Join-Path $PSScriptRoot "extensions/sofa/index.ts"
$cwd = (Get-Location).Path
function Up { (herdr --session $Session workspace list 2>$null) -match '"result"' }

if (-not (Up)) {
    Start-Process herdr -ArgumentList "--session", $Session, "server" -WindowStyle Hidden
    foreach ($i in 1..50) { if (Up) { break }; Start-Sleep -Milliseconds 200 }
    if (-not (Up)) { throw "herdr session '$Session' did not start" }
}

$ws = herdr --session $Session workspace create --cwd $cwd --label (Split-Path $cwd -Leaf) --focus | ConvertFrom-Json
herdr --session $Session pane run $ws.result.root_pane.pane_id "mise x pi -- pi -e `"$ext`" -e git:github.com/lgranie/pi-decision-provider" | Out-Null
herdr session attach $Session
