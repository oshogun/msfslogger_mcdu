param([string]$CommunityPath, [string]$SdkRoot = $env:MSFS_SDK, [switch]$Build)
$ErrorActionPreference='Stop'; $root=Split-Path $PSScriptRoot -Parent
if($Build){& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-gauge.ps1') -SdkRoot $SdkRoot; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}
$source=Join-Path $root 'gauge\msfs\Packages\msfslogger-cdu'
if(-not (Test-Path -LiteralPath (Join-Path $source 'layout.json'))){throw 'Build the gauge first with tools/build-gauge.ps1.'}
if(-not $CommunityPath){
  $cfg=@("$env:APPDATA\Microsoft Flight Simulator\UserCfg.opt","$env:LOCALAPPDATA\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache\UserCfg.opt") | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
  if($cfg){$line=Get-Content -LiteralPath $cfg | Where-Object {$_ -match '^InstalledPackagesPath\s+"(.+)"$'} | Select-Object -Last 1; if($line -match '^InstalledPackagesPath\s+"(.+)"$'){$CommunityPath=Join-Path $Matches[1] 'Community'}}
}
if(-not $CommunityPath){throw 'Community path was not found. Supply -CommunityPath explicitly.'}
$CommunityPath=[IO.Path]::GetFullPath($CommunityPath)
if(-not (Test-Path -LiteralPath $CommunityPath -PathType Container)){throw "Community folder does not exist: $CommunityPath"}
$destination=Join-Path $CommunityPath 'msfslogger-cdu'; New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force
Write-Host "Installed MSFSLogger CDU at $destination"
Write-Host 'Restart MSFS after first install; after updates, use Developer Mode > Tools > Resync.'
