# run-tunnel-watchdog.ps1 -- scheduled task wrapper for scripts/tunnel-watchdog.mjs
#
# ASCII only on purpose (PS 5.1 without BOM misreads non-ASCII as cp932 and breaks parsing).
#
# Why this wrapper exists:
#   - the watchdog needs SLACK_WEBHOOK_URL, which lives in ~/.claude/.env (git-ignored, per-PC)
#   - fleet rule: scheduled tasks must use FULL PATHS for the executable; a bare "node" does not
#     resolve under the S4U/scheduled context and fails silently with 0x80070002
#   - the node exit code must reach the task's LastTaskResult so that ScheduledTaskHealth
#     (the fleet-wide watchdog) can see a failure
#
# Usage:
#   "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File <this>

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot "tunnel-watchdog.mjs"
$node = "C:\nvm4w\nodejs\node.exe"

if (-not (Test-Path -LiteralPath $node))   { Write-Error "node not found: $node"; exit 2 }
if (-not (Test-Path -LiteralPath $script)) { Write-Error "watchdog not found: $script"; exit 2 }

# Load SLACK_WEBHOOK_URL from ~/.claude/.env (KEY=VALUE lines, # comments ignored).
$envFile = Join-Path $env:USERPROFILE ".claude\.env"
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        $t = $line.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith("#")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        if ($k -ne "SLACK_WEBHOOK_URL") { continue }
        $v = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
        $env:SLACK_WEBHOOK_URL = $v
    }
}
if (-not $env:SLACK_WEBHOOK_URL) {
    # Do not fail the task for this, but make it visible: without it the watchdog can only
    # write to stderr, and a silent watchdog is the exact failure mode we are fixing.
    Write-Warning "SLACK_WEBHOOK_URL not found in $envFile - Slack notification is DISABLED"
}

Push-Location $root
try {
    & $node $script
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $code
