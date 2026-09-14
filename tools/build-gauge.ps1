param([string]$SdkRoot = $env:MSFS_SDK)
$ErrorActionPreference='Stop'; $root=Split-Path $PSScriptRoot -Parent
if(-not $SdkRoot){$SdkRoot='C:\MSFS SDK'}
$node=(Get-Command node -ErrorAction SilentlyContinue).Source
if(-not $node){$node=Get-ChildItem (Join-Path $root '.tools') -Filter node.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName}
if(-not $node){throw 'Node.js 20 or newer was not found.'}
$env:MSFS_SDK=$SdkRoot; & $node (Join-Path $root 'gauge/msfs/tools/build.mjs'); exit $LASTEXITCODE
