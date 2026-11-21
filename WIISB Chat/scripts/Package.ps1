$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $project
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
& npm.cmd run package
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
$release = Join-Path $project 'release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'apps\desktop\src-tauri\target\release\WIISB Chat.exe') -Destination $release -Force
Get-ChildItem -LiteralPath (Join-Path $project 'apps\desktop\src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' | Copy-Item -Destination $release -Force
Get-ChildItem -LiteralPath $release -Filter '*.exe' | Get-FileHash -Algorithm SHA256 | Format-Table -AutoSize
