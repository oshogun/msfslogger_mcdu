param([string]$SdkRoot = $env:MSFS_SDK, [switch]$Launch)
$ErrorActionPreference = 'Stop'
if (-not $SdkRoot) { $SdkRoot = 'C:\MSFS SDK' }
$debugger = Join-Path $SdkRoot 'Tools\CoherentGT Debugger\Debugger.exe'
if (-not (Test-Path -LiteralPath $debugger -PathType Leaf)) {
    Write-Host "Coherent GT Debugger not found at $debugger"
    Write-Host 'Install the MSFS 2020 SDK using the simulator Developer Mode SDK installer, or supply -SdkRoot with your existing SDK directory.'
    exit 1
}
Write-Host "Debugger: $debugger"
Write-Host 'MSFS 2020 target: http://127.0.0.1:19999'
Write-Host 'Load a flight with the gauge, select its VCockpit view, and enable Network > Ignore Cache.'
if ($Launch) { Start-Process -FilePath $debugger -WorkingDirectory (Split-Path $debugger) -WindowStyle Hidden }
