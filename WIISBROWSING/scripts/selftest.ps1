# Runs WIISBROWSING's end-to-end self-test: a real browser window, a local web server and ~30 observed checks,
# then a second process that proves the saved session is restored. Uses its own throw-away data folder.
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\publish\win-x64\WIISBROWSING.exe"),
    [string]$Work = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.selftest")))
)
$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path
if (Test-Path $Work) { Get-ChildItem $Work -Force | ForEach-Object { try { [IO.Directory]::Delete($_.FullName, $true) } catch { try { [IO.File]::Delete($_.FullName) } catch {} } } }
New-Item -ItemType Directory -Force $Work | Out-Null

function Run-Phase([string]$resultFile) {
    $p = Start-Process $Exe -ArgumentList "--data-dir", "`"$Work\data`"", "--selftest", "`"$Work\out`"" -PassThru
    $t0 = Get-Date
    while (-not $p.HasExited -and ((Get-Date) - $t0).TotalMinutes -lt 6) { Start-Sleep 2 }
    if (-not $p.HasExited) { $p | Stop-Process -Force; Write-Host "TIMED OUT" -ForegroundColor Red }
    $f = Join-Path $Work "out\$resultFile"
    if (-not (Test-Path $f)) { Write-Host "No results written: $resultFile" -ForegroundColor Red; return @{ failed = 1; passed = 0 } }
    $r = Get-Content $f -Raw | ConvertFrom-Json
    foreach ($x in $r.results) {
        $tag = if ($x.Passed) { "PASS" } else { "FAIL" }
        $color = if ($x.Passed) { "Green" } else { "Red" }
        Write-Host ("{0}  {1}" -f $tag, $x.Name) -ForegroundColor $color
        Write-Host ("      {0}" -f $x.Detail) -ForegroundColor DarkGray
    }
    return $r
}

Write-Host "== Phase 1: browsing, downloads, popups, permissions, privacy, tabs, themes, pages ==" -ForegroundColor Cyan
$a = Run-Phase "selftest-results.json"
Start-Sleep 3
Write-Host "== Phase 2: a fresh process restores the saved session ==" -ForegroundColor Cyan
$b = Run-Phase "selftest-results-restart.json"
$failed = [int]$a.failed + [int]$b.failed
$passed = [int]$a.passed + [int]$b.passed
Write-Host ("`nTOTAL: {0} passed, {1} failed. Screenshots are in {2}\out" -f $passed, $failed, $Work) -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
exit $failed
