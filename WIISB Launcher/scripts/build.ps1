# Builds WIISB Launcher: frontend tests, backend tests, then the production exe + installers.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

npm install
npm test
if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }
cargo test --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "Rust tests failed" }
& (Join-Path $PSScriptRoot "stage-apps.ps1")
npm run tauri:build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed" }

Write-Host "`nArtifacts:" -ForegroundColor Cyan
Get-ChildItem "src-tauri\target\release\wiisb-launcher.exe", "src-tauri\target\release\bundle\*\*" -ErrorAction SilentlyContinue |
  Where-Object { -not $_.PSIsContainer } | ForEach-Object { "{0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB) }
