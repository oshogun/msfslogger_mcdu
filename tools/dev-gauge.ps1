param([int]$Port = 8380)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
    Get-ChildItem (Join-Path $root '.tools') -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nodePath) { throw 'Install Node.js 20 or newer, reopen PowerShell, and run this command again.' }
& $nodePath (Join-Path $root 'gauge/dev/server.mjs') --port $Port
exit $LASTEXITCODE
