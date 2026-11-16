$ErrorActionPreference = 'Stop'
$editorRoot = $PSScriptRoot
$editorUrl = 'http://127.0.0.1:48176'
$editorRunning = $false
try {
    $health = Invoke-RestMethod "$editorUrl/health" -TimeoutSec 2
    $editorRunning = $health.app -eq 'KingdomIncSaveEditor' -and $health.root -eq $editorRoot
} catch {}
if (-not $editorRunning) {
    $py = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python.exe -ErrorAction SilentlyContinue }
    if (-not $py) { throw 'Python 3 is required to serve the Save Editor. Install Python or run: python server.py' }
    Start-Process -FilePath $py.Source -ArgumentList @('"' + (Join-Path $editorRoot 'server.py') + '"', '--no-browser') -WorkingDirectory $editorRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod "$editorUrl/health" -TimeoutSec 1
            if ($health.app -eq 'KingdomIncSaveEditor' -and $health.root -eq $editorRoot) { $editorRunning = $true; break }
        } catch {}
    }
}
if (-not $editorRunning) { throw 'Could not start the Save Editor. Port 48176 may already be in use. Run python server.py --port 48177 to choose another port.' }
Start-Process $editorUrl

