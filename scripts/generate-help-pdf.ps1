# Regenerates PI-Transfer-Tracker-How-To-Use.pdf from help.html using headless Chrome.
# Run from Windows PowerShell — Chrome doesn't need to be installed in WSL.
#
# Usage from repo root (in an already-open pwsh):
#   .\scripts\generate-help-pdf.ps1
#
# If PowerShell blocks the script because it lives on \\wsl.localhost\ and gets
# flagged as a network file, either:
#   Unblock-File .\scripts\generate-help-pdf.ps1     # one-time
# or launch a shell that bypasses the policy for the single run:
#   pwsh -ExecutionPolicy Bypass -File .\scripts\generate-help-pdf.ps1
#
# The script auto-locates chrome.exe in the usual install paths. If Chrome lives
# somewhere else, set $env:CHROME_EXE before running.

$ErrorActionPreference = 'Stop'

# --- Locate Chrome ------------------------------------------------------------
$chromeCandidates = @(
    $env:CHROME_EXE,
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'   # Edge works too — same engine
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $chromeCandidates) {
    throw "Chrome/Edge not found. Set `$env:CHROME_EXE to the browser executable path."
}
$browser = $chromeCandidates[0]
Write-Host "Using browser: $browser" -ForegroundColor Cyan

# --- Resolve paths ------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot   # scripts/.. → repo root
$helpHtml = Join-Path $repoRoot 'help.html'
$outPdf   = Join-Path $repoRoot 'PI-Transfer-Tracker-How-To-Use.pdf'

if (-not (Test-Path $helpHtml)) {
    throw "help.html not found at $helpHtml"
}

# Chrome needs a file:// URL. UNC paths (\\wsl.localhost\...) work directly.
$helpUri = ([System.Uri]$helpHtml).AbsoluteUri
Write-Host "Source: $helpUri"
Write-Host "Output: $outPdf"

# --- Render -------------------------------------------------------------------
# Isolated user-data-dir prevents this run from touching the user's normal Chrome profile.
$tmpProfile = Join-Path $env:TEMP ("chrome-pdf-" + [guid]::NewGuid().ToString('N').Substring(0,8))
try {
    $args = @(
        '--headless=new'
        '--disable-gpu'
        '--no-pdf-header-footer'
        "--user-data-dir=$tmpProfile"
        "--print-to-pdf=$outPdf"
        '--no-margins'
        $helpUri
    )
    & $browser @args 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Chrome exited with code $LASTEXITCODE" }
    if (-not (Test-Path $outPdf)) { throw "PDF was not created at $outPdf" }
    $size = (Get-Item $outPdf).Length
    Write-Host ("PDF written ({0:N0} bytes)" -f $size) -ForegroundColor Green
} finally {
    if (Test-Path $tmpProfile) { Remove-Item -Recurse -Force $tmpProfile -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Next: commit the updated PDF." -ForegroundColor Yellow
Write-Host "  git add PI-Transfer-Tracker-How-To-Use.pdf"
Write-Host "  git commit -m 'Regenerate help PDF'"
Write-Host "  git push"
