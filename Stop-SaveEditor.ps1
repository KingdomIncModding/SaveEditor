$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^python') -and ($_.CommandLine -match [regex]::Escape($PSScriptRoot))
}
foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force
}
Write-Host "Stopped Kingdom Inc Save Editor server."

