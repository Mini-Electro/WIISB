# Copies the other WIISB apps' NEWEST setup programs into src-tauri\apps so they are packed inside the launcher.
# Run by build.ps1 before the Tauri build. Missing installers are a hard error: a launcher without them can't install anything.
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$workspace = Join-Path $root ".."
$dest = Join-Path $root "src-tauri\apps"
New-Item -ItemType Directory -Force $dest | Out-Null

$apps = @(
  @{ Name = "WIISB Chat";    Dir = "WIISB Chat\release";  Pattern = "WIISB Chat_*_x64-setup.exe";    To = "WIISB-Chat-setup.exe" },
  @{ Name = "WIISBROWSING";  Dir = "WIISBROWSING\release"; Pattern = "WIISBROWSING_*_x64-setup.exe"; To = "WIISBROWSING-setup.exe" }
)
foreach ($a in $apps) {
  $dir = Join-Path $workspace $a.Dir
  # The newest version by number (0.1.10 is newer than 0.1.9), not by file date or name.
  $newest = Get-ChildItem $dir -Filter $a.Pattern -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '_(\d+\.\d+\.\d+)_x64' } |
    Sort-Object { [version]([regex]::Match($_.Name, '_(\d+\.\d+\.\d+)_x64').Groups[1].Value) } -Descending |
    Select-Object -First 1
  if (-not $newest) { throw "$($a.Name) installer not found in $dir  (build that project's release first)" }
  Copy-Item $newest.FullName (Join-Path $dest $a.To) -Force
  "{0}: {1} -> {2:N1} MB" -f $a.To, $newest.Name, ((Get-Item (Join-Path $dest $a.To)).Length / 1MB)
}
