# Prepares the self-contained runtime bundle so `npm run dist` can
# produce a portable exe that does not depend on a pre-installed Node/dsh:
#
#   vendor/node/node.exe
#   vendor/dsh/node_modules/@deepseek-ai/dsh   (dsh + full dependency tree)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/prepare-vendor.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/prepare-vendor.ps1 -NodeExe D:\nodejs\node.exe

param(
  [string]$NodeExe = '',   # path to node.exe; defaults to the node on PATH
  [string]$DshRoot = ''    # node_modules root containing @deepseek-ai/dsh
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor'

# 1. Node runtime
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodeExe -or -not (Test-Path $NodeExe)) { throw 'node.exe not found on PATH; pass -NodeExe <path-to-node.exe>' }
New-Item -ItemType Directory -Force -Path (Join-Path $Vendor 'node') | Out-Null
Copy-Item $NodeExe (Join-Path $Vendor 'node\node.exe') -Force
Write-Host ('node: ' + $NodeExe)

# 2. dsh package + its full dependency tree
$candidates = @()
if ($DshRoot) { $candidates += Join-Path $DshRoot 'node_modules' }
if ($env:NODE_PATH) { $candidates += $env:NODE_PATH.Split(';') }
try { $candidates += (npm root -g) } catch {}
$src = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path (Join-Path $c '@deepseek-ai\dsh\lib\bin.js'))) { $src = $c; break }
}
if (-not $src) { throw 'Installed @deepseek-ai/dsh not found. Install it first: npm install -g @deepseek-ai/dsh' }
$dst = Join-Path $Vendor 'dsh\node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy (Join-Path $src '@deepseek-ai\dsh') (Join-Path $dst 'dsh') /E /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
Write-Host ('dsh: ' + (Join-Path $src '@deepseek-ai\dsh'))
Write-Host ('vendor prepared: ' + $Vendor)
