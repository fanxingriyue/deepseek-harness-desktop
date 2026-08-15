$ErrorActionPreference = 'Continue'
$repo = 'D:\deepseek\deepseek-harness-desktop'
$logRoot = Join-Path $repo 'adopt-test'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = Join-Path $logRoot "summary-$ts.txt"
Add-Content -Path $summary -Value "START $ts"

function Invoke-Run {
  param([string]$Name, [string]$Mode)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Remove-Item "$env:TEMP\dsh-desktop-smoke.json" -ErrorAction SilentlyContinue
  $outLog = Join-Path $logRoot "$Name.out.log"
  $errLog = Join-Path $logRoot "$Name.err.log"
  $env:DSH_DESKTOP_SMOKE = '1'
  if ($Mode -eq 'keep') { $env:DSH_DESKTOP_SMOKE_KEEP = '1' } else { Remove-Item Env:DSH_DESKTOP_SMOKE_KEEP -ErrorAction SilentlyContinue }
  $exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
  $p = Start-Process -FilePath $exe -ArgumentList '.', '--no-sandbox' -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $deadline = (Get-Date).AddSeconds(160)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { break }
    if (Test-Path "$env:TEMP\dsh-desktop-smoke.json") { break }
    Start-Sleep -Milliseconds 250
  }
  $sw.Stop()
  $smoke = if (Test-Path "$env:TEMP\dsh-desktop-smoke.json") { (Get-Content "$env:TEMP\dsh-desktop-smoke.json" -Raw).Trim() } else { 'NO-SMOKE' }
  $srvPath = Join-Path $env:APPDATA 'deepseek-harness-desktop\server.json'
  $server = if (Test-Path $srvPath) { (Get-Content $srvPath -Raw).Trim() } else { 'NO-SERVER.JSON' }
  $line = "[$Name] elapsed=$([math]::Round($sw.Elapsed.TotalSeconds,1))s mode=$Mode smoke=$smoke serverJson=$server exited=$($p.HasExited)"
  Add-Content -Path $summary -Value $line
  if (-not $p.HasExited) {
    $null = $p.WaitForExit(25000)
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; Add-Content -Path $summary -Value "[$Name] force-killed electron" }
  }
  Start-Sleep -Milliseconds 500
}

Invoke-Run -Name 'run1-fresh' -Mode 'kill'
Invoke-Run -Name 'run2-keep'  -Mode 'keep'
Invoke-Run -Name 'run3-adopt' -Mode 'kill'
Add-Content -Path $summary -Value "DONE $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
