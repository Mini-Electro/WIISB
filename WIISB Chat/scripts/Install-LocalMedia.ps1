$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath((Join-Path $project '.data\tools\livekit'))
if (-not $destination.StartsWith($project + [IO.Path]::DirectorySeparatorChar)) { throw 'Invalid tools directory.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$version = '1.13.11'
$assetName = "livekit_${version}_windows_amd64.zip"
$base = "https://github.com/livekit/livekit/releases/download/v$version"
$archive = Join-Path $destination $assetName
Invoke-WebRequest -Uri "$base/$assetName" -OutFile $archive
$checksums = (Invoke-WebRequest -Uri "$base/checksums.txt").Content
if ($checksums -is [byte[]]) { $checksums = [Text.Encoding]::UTF8.GetString($checksums) }
$line = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith($assetName) } | Select-Object -First 1)
if (-not $line) { throw 'No official checksum was found.' }
$expected = ($line.Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw 'LiveKit checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
Write-Host "Verified LiveKit installed in $destination"
Write-Host 'For local testing only: .\scripts\Start-LocalMedia.ps1'
