# Copies the other WIISB apps' setup programs into src-tauri\apps so they are packed inside the launcher.
# Run by build.ps1 before the Tauri build. Missing installers are a hard error: a launcher without them can't install anything.
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$workspace = Join-Path $root ".."
$dest = Join-Path $root "src-tauri\apps"
New-Item -ItemType Directory -Force $dest | Out-Null

$apps = @(
  @{ Name = "WIISB Chat";    From = "WIISB Chat\release\WIISB Chat_0.1.0_x64-setup.exe";          To = "WIISB-Chat-setup.exe" },
  @{ Name = "WIISBROWSING";  From = "WIISBROWSING\release\WIISBROWSING_0.1.0_x64-setup.exe";      To = "WIISBROWSING-setup.exe" }
)
foreach ($a in $apps) {
  $src = Join-Path $workspace $a.From
  if (-not (Test-Path $src)) { throw "$($a.Name) installer not found: $src  (build that project's release first)" }
  Copy-Item $src (Join-Path $dest $a.To) -Force
  "{0}: {1:N1} MB" -f $a.To, ((Get-Item (Join-Path $dest $a.To)).Length / 1MB)
}
