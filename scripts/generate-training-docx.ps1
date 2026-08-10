# Generates Word .docx versions of the new-location training doc and welcome email
# from their HTML sources. Ashley opens the .docx, fills in [LOCATION] / [DATE] /
# [START DATE] etc., and sends. Requires Microsoft Word installed (uses Word COM).
#
# Usage from repo root (pwsh):
#   .\scripts\generate-training-docx.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$jobs = @(
    @{ Html = 'training-new-location.html'; Docx = 'PI-Transfer-Tracker-Getting-Started.docx' },
    @{ Html = 'email-new-location.html';    Docx = 'PI-Transfer-Tracker-Welcome-Email.docx' }
)

foreach ($j in $jobs) {
    $htmlPath = Join-Path $repoRoot $j.Html
    $docxPath = Join-Path $repoRoot $j.Docx
    if (-not (Test-Path $htmlPath)) { throw "Source HTML not found: $htmlPath" }
    Write-Host "Converting $($j.Html) -> $($j.Docx)" -ForegroundColor Cyan
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
# Word constants: wdFormatDocumentDefault = 16 (.docx)
$wdFormatDocumentDefault = 16

try {
    foreach ($j in $jobs) {
        $htmlPath = Join-Path $repoRoot $j.Html
        $docxPath = Join-Path $repoRoot $j.Docx
        if (Test-Path $docxPath) { Remove-Item $docxPath -Force }

        $doc = $word.Documents.Open($htmlPath, [ref]$false, [ref]$true) # ReadOnly=true so Word doesn't lock the HTML
        try {
            $doc.SaveAs([ref]$docxPath, [ref]$wdFormatDocumentDefault)
            $size = (Get-Item $docxPath).Length
            Write-Host ("  wrote {0} ({1:N0} bytes)" -f $j.Docx, $size) -ForegroundColor Green
        } finally {
            $doc.Close([ref]$false)
        }
    }
} finally {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

Write-Host ""
Write-Host "Done. Fill in [LOCATION] / [START DATE] / [TRAINING DATE] placeholders in Word before sending." -ForegroundColor Yellow
