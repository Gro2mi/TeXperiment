# Local Windows build: mirrors the CI build job (.github/workflows/build.yml).
# Produces dist\TeXperiment\ (one-dir app) and dist\TeXperimentSetup-<ver>.exe.
# Build-time downloads only: build tools (pip), tectonic binary, Inno Setup.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$Version = python -c "import sys; sys.path.insert(0, '.'); from texperiment import __version__; print(__version__)"

Write-Host "== TeXperiment $Version build =="

# 1. build-time python deps (user site)
python -m pip install --quiet --user pyinstaller pywebview pillow

# 2. vendored math libs must be present and unmodified
python packaging/fetch_vendor.py --check

# 3. bundled tectonic fallback binary
python packaging/fetch_tectonic.py

# 4. one-dir PyInstaller build
python -m PyInstaller texperiment.spec --noconfirm --distpath dist --workpath build
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

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
