$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\.data\tools\livekit\livekit-server.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Run scripts\Install-LocalMedia.ps1 first.' }
& $exe --dev --bind 127.0.0.1 --node-ip 127.0.0.1
