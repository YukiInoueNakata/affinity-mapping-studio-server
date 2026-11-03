# Extract the trycloudflare.com URL from the cloudflared log.
# Called from start-server.bat in a polling loop.
# Outputs the URL on stdout if found, nothing otherwise.

$cfLog = Join-Path $env:TEMP 'kj-cloudflared.log'
if (-not (Test-Path $cfLog)) { exit 0 }
$m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($m) {
  Write-Output $m.Matches[0].Value
}
