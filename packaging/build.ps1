# Local Windows build: mirrors the CI build job (.github/workflows/build.yml).
# Produces dist\TeXperiment\ (one-dir app) and dist\TeXperimentSetup-<ver>.exe.
# Build-time downloads only: build tools (pip), tectonic binary, Inno Setup.
#
# -Unpacked: skip the installer and zip; leave the one-dir app directly at
# dist\TeXperiment-<ver>\ for fast distribution testing (run
# dist\TeXperiment-<ver>\TeXperiment.exe — no unpacking, no installer).
# -Incremental: skip PyInstaller entirely — copy the cached third-party
# payload (build\distcache, populated by the last full build) and overlay
# ONLY the first-party code (texperiment/, web/, tectonic/). App-code
# edits reach the dist in seconds; run a full build when dependencies or
# the spec change (validated by a stamp, else the full path runs).
# -ServerOnly: build the server-only flavor (TEXPERIMENT_FLAVOR=server):
# no pywebview/PIL, console exe named TeXperiment-Server, packaged as a
# plain zip — it runs the server and opens the browser on start.
param([switch]$Unpacked, [switch]$Incremental, [switch]$ServerOnly)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if ($ServerOnly) { $env:TEXPERIMENT_FLAVOR = 'server' }
$AppName = if ($ServerOnly) { 'TeXperiment-Server' } else { 'TeXperiment' }

$Version = python -c "import sys; sys.path.insert(0, '.'); from texperiment import __version__; print(__version__)"

Write-Host "== TeXperiment $Version build ($AppName) =="

# payload cache: the third-party part of the last full build. The stamp
# pins everything the cache's content depends on that is NOT first-party
# app code (which is always overlaid fresh) — including the flavor, so
# desktop and server caches never mix
$CacheDir = if ($ServerOnly) { 'build\distcache-server' } else { 'build\distcache' }
$StampFiles = @('requirements.txt', 'texperiment.spec',
                'packaging/run_desktop.py')
function Get-PayloadStamp {
    # double-quoted outer (PowerShell), single-quoted inner (Python):
    # PowerShell strips double quotes when passing args to native exes
    $pyi = python -m PyInstaller --version
    $pyv = python -c "import sys; print(str(sys.version_info[0]) + '.' + str(sys.version_info[1]))"
    $hashes = ($StampFiles | ForEach-Object {
        (Get-FileHash $_ -Algorithm SHA256).Hash
    }) -join '|'
    $input = "$AppName|$pyi|$pyv|$hashes"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($input)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
}

if ($Incremental -and (Test-Path "$CacheDir\.stamp") -and
        (Get-Content "$CacheDir\.stamp" -Raw).Trim() -eq (Get-PayloadStamp)) {
    Write-Host '== incremental: reusing cached third-party payload =='
    # cheap no-op-when-present checks — the overlay copies both trees
    python packaging/fetch_vendor.py --check
    python packaging/fetch_tectonic.py
    if (Test-Path "dist\$AppName") {
        Remove-Item -Recurse -Force "dist\$AppName"
    }
    robocopy $CacheDir "dist\$AppName" /MIR /XF .stamp /NFL /NDL /NJH | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "cache copy failed (exit $LASTEXITCODE)" }
    # first-party overlay: app code, served web tree, tectonic binary.
    # /MIR makes the target exactly the source (removes stale files);
    # robocopy exit codes < 8 are success (flags, not errors)
    foreach ($pair in @(
        @('texperiment', '_internal\texperiment'),
        @('web', '_internal\web'),
        @('packaging\tectonic', '_internal\tectonic'))) {
        $dst = "dist\$AppName\$($pair[1])"
        robocopy $pair[0] $dst /MIR /NFL /NDL `
            /NJH /XF *.pyc /XD __pycache__ | Out-Null
        if ($LASTEXITCODE -ge 8) {
            # plain ASCII inside double-quoted strings: PowerShell 5.1
            # reads BOM-less UTF-8 as ANSI, and an em-dash decodes to a
            # Windows-1252 closing quote — it would terminate the string
            throw "robocopy failed for $($pair[0]) (exit $LASTEXITCODE -- is the previous dist still running?)"
        }
    }
} else {
    if ($Incremental) {
        Write-Host '== incremental requested but cache missing/stale — full build =='
    }

    # 1. build-time python deps (user site)
    python -m pip install --quiet --user pyinstaller pywebview pillow

    # 2. vendored math libs must be present and unmodified
    python packaging/fetch_vendor.py --check

    # 3. bundled tectonic fallback binary
    python packaging/fetch_tectonic.py

    # 4. one-dir PyInstaller build
    python -m PyInstaller texperiment.spec --noconfirm --distpath dist --workpath build
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

    # populate the payload cache for the next incremental build
    if (Test-Path $CacheDir) {
        Remove-Item -Recurse -Force $CacheDir
    }
    robocopy "dist\$AppName" $CacheDir /MIR /XF .stamp /NFL /NDL /NJH | Out-Null
    Get-PayloadStamp | Set-Content "$CacheDir\.stamp" -NoNewline
}

if ($Unpacked) {
    # versioned folder so several builds can sit side by side in dist\
    if (Test-Path "dist\$AppName-$Version") {
        Remove-Item -Recurse -Force "dist\$AppName-$Version"
    }
    Move-Item "dist\$AppName" "dist\$AppName-$Version"
    Write-Host "== done: dist\$AppName-$Version (run $AppName.exe inside) =="
    exit 0
}

if ($ServerOnly) {
    # the server flavor ships as a plain zip — no installer, no setup
    Compress-Archive -Path "dist\$AppName" `
        -DestinationPath "dist\TeXperiment-$Version-server-windows.zip" -Force
    Write-Host "== done: dist\TeXperiment-$Version-server-windows.zip =="
    exit 0
}

# 5. installer via Inno Setup (winget install, then PATH probe)
$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
    foreach ($cand in @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
        if (Test-Path $cand) { $iscc = $cand; break }
    }
}
if (-not $iscc) {
    Write-Host 'installing Inno Setup via winget...'
    winget install --id JRSoftware.InnoSetup -e --accept-source-agreements `
        --accept-package-agreements --silent
    $iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    if (-not (Test-Path $iscc)) { throw 'ISCC.exe not found after winget install' }
}
& $iscc "/DVERSION=$Version" packaging/installer.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }

# 6. plain zip alongside the installer — users choose their install form
Compress-Archive -Path dist\TeXperiment -DestinationPath "dist\TeXperiment-$Version-windows.zip" -Force

Write-Host "== done: dist\TeXperimentSetup-$Version.exe + dist\TeXperiment-$Version-windows.zip =="
