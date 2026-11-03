# Generate a 64-hex random admin token and save to config/admin-token.txt (UTF-8 no BOM).
# Called from start-server.bat.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configDir = Join-Path (Split-Path -Parent $scriptDir) 'config'
if (-not (Test-Path $configDir)) {
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$tokenPath = Join-Path $configDir 'admin-token.txt'
$token = ([guid]::NewGuid().ToString('N')) + ([guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tokenPath, $token, $utf8NoBom)
Write-Output "Generated token: $($token.Substring(0,8))...$($token.Substring($token.Length-4))"
