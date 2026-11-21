# Builds a signed release of one WIISB app and prepares the files to upload to GitHub.
#
#   .\scripts\Release-App.ps1 -App chat     -Version 0.1.1 -Notes "What changed"
#   .\scripts\Release-App.ps1 -App browser  -Version 0.1.1
#   .\scripts\Release-App.ps1 -App launcher -Version 1.0.1     (release chat and browser first: the launcher bundles their installers)
#
# One-time setup is in UPDATES.md.
# The finished files are in releases\<app>\v<version>\ - attach every file there to the app's release on GitHub (tag from update-config.json).
param(
    [Parameter(Mandatory)][ValidateSet('chat', 'launcher', 'browser')][string]$App,
    [Parameter(Mandatory)][string]$Version,
    [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$base = Split-Path $PSScriptRoot -Parent
$keys = Join-Path $env:USERPROFILE '.wiisb-keys'
$cfg = Get-Content (Join-Path $PSScriptRoot 'update-config.json') -Raw | ConvertFrom-Json
$owner = "$($cfg.githubOwner)".Trim()
if (-not $owner) { throw "Put your GitHub username in scripts\update-config.json (githubOwner) first - see UPDATES.md." }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 0.1.1" }
$repo = "$owner/$($cfg.repo)"
$tag = $cfg.releaseTags.$App
if (-not $tag) { throw "No release tag for $App in scripts\update-config.json." }
$spec = "$repo@$tag"   # compiled into the app: where it looks for updates
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

function Set-FirstMatch([string]$Path, [string]$Pattern, [string]$Replacement) {
    $text = [IO.File]::ReadAllText($Path)
    $re = [regex]$Pattern
    if (-not $re.IsMatch($text)) { throw "No version found in $Path" }
    [IO.File]::WriteAllText($Path, $re.Replace($text, $Replacement, 1), (New-Object Text.UTF8Encoding $false))
}
function Set-Version([string[]]$Files) {
    foreach ($f in $Files) {
        if ($f -like '*.toml') { Set-FirstMatch $f '(?m)^(version\s*=\s*")[^"]+(")' ('${1}' + $Version + '${2}') }
        else { Set-FirstMatch $f '("version"\s*:\s*")[^"]+(")' ('${1}' + $Version + '${2}') }
    }
}
function Write-Utf8NoBom([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$out = Join-Path $base "releases\$App\v$Version"
New-Item -ItemType Directory -Force $out | Out-Null
Write-Host "Releasing $App $Version for github.com/$repo (release tag $tag)" -ForegroundColor Cyan

if ($App -eq 'browser') {
    $proj = Join-Path $base 'WIISBROWSING'
    $key = Join-Path $keys 'browser-update.key'
    if (-not (Test-Path $key)) { throw "Missing $key - the browser signing key." }
    Set-FirstMatch (Join-Path $proj 'src\WIISBROWSING.App\WIISBROWSING.App.csproj') '(<Version>)[^<]+(</Version>)' ('${1}' + $Version + '${2}')
    & (Join-Path $proj 'scripts\build.ps1') -Version $Version -UpdateRepo $spec
    if ($LASTEXITCODE -ne 0) { throw 'Browser build failed.' }
    $setup = Join-Path $proj "release\WIISBROWSING_${Version}_x64-setup.exe"
    if (-not (Test-Path $setup)) { throw "Installer not found: $setup" }
    Copy-Item $setup $out -Force
    $env:DOTNET_ROOT = "$env:USERPROFILE\.dotnet"; $env:Path = "$env:USERPROFILE\.dotnet;$env:Path"
    dotnet run --project (Join-Path $proj 'tools\UpdateSigner') -- sign --file (Join-Path $out (Split-Path $setup -Leaf)) --key $key --version $Version --repo $repo --tag $tag --notes $Notes --out $out
    if ($LASTEXITCODE -ne 0) { throw 'Signing failed.' }
}
else {
    $key = Join-Path $keys 'tauri.key'
    if (-not (Test-Path $key)) { throw "Missing $key - the signing key." }
    if ($App -eq 'chat') {
        $proj = Join-Path $base 'WIISB Chat'
        Set-Version @((Join-Path $proj 'apps\desktop\src-tauri\tauri.conf.json'), (Join-Path $proj 'apps\desktop\src-tauri\Cargo.toml'), (Join-Path $proj 'apps\desktop\package.json'))
        $nsis = Join-Path $proj 'apps\desktop\src-tauri\target\release\bundle\nsis'
        $product = 'WIISB Chat'; $friendly = 'WIISB-Chat'
    } else {
        $proj = Join-Path $base 'WIISB Launcher'
        Set-Version @((Join-Path $proj 'src-tauri\tauri.conf.json'), (Join-Path $proj 'src-tauri\Cargo.toml'), (Join-Path $proj 'package.json'))
        $nsis = Join-Path $proj 'src-tauri\target\release\bundle\nsis'
        $product = 'WIISB Launcher'; $friendly = 'WIISB-Launcher'
    }
    # The repository is compiled in; the signing key and "make update files" switch only exist for this build.
    $env:WIISB_UPDATE_REPO = $spec
    $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($key).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    # Tauri 2 ignores the TAURI_CONFIG variable here, so switch "make update files" on in the config for this build only
    # and put the original text back afterwards.
    $confPath = Join-Path (Split-Path $nsis -Parent | Split-Path -Parent | Split-Path -Parent | Split-Path -Parent) 'tauri.conf.json'
    $confOriginal = [IO.File]::ReadAllText($confPath)
    $confObj = $confOriginal | ConvertFrom-Json
    $confObj.bundle | Add-Member -NotePropertyName createUpdaterArtifacts -NotePropertyValue $true -Force
    Write-Utf8NoBom $confPath ($confObj | ConvertTo-Json -Depth 20)
    try {
        if ($App -eq 'chat') { & (Join-Path $proj 'scripts\Package.ps1') } else { & (Join-Path $proj 'scripts\build.ps1') }
    } finally {
        Write-Utf8NoBom $confPath $confOriginal
        Remove-Item Env:\WIISB_UPDATE_REPO, Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    }
    $setup = Get-ChildItem $nsis -Filter "${product}_${Version}_x64-setup.exe" | Select-Object -First 1
    if (-not $setup) { throw "Installer not found in $nsis" }
    $sigFile = "$($setup.FullName).sig"
    if (-not (Test-Path $sigFile)) { throw "No signature was produced ($sigFile)." }
    # GitHub turns spaces in file names into dots, so give the file a name without spaces.
    $name = "${friendly}_${Version}_x64-setup.exe"
    Copy-Item $setup.FullName (Join-Path $out $name) -Force
    $manifest = [ordered]@{
        version  = $Version
        notes    = $Notes
        pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{ 'windows-x86_64' = [ordered]@{
            signature = ([IO.File]::ReadAllText($sigFile)).Trim()
            url       = "https://github.com/$repo/releases/download/$tag/$name"
        } }
    }
    Write-Utf8NoBom (Join-Path $out 'latest.json') ($manifest | ConvertTo-Json -Depth 6)
}

Write-Host "`nDone. Files to upload:" -ForegroundColor Green
Get-ChildItem $out | ForEach-Object { "  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB) }
Write-Host "`nNext: on https://github.com/$repo/releases open the release tagged $tag (create it the first time: tag $tag, any title)," -ForegroundColor Cyan
Write-Host "delete its old files, attach every file listed above (including latest.json), and publish." -ForegroundColor Cyan
Write-Host "Everyone's $App then updates itself within a few hours." -ForegroundColor Cyan
