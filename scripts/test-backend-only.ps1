$ErrorActionPreference = 'Continue'
$repo = 'D:\deepseek\deepseek-harness-desktop'
$srvPath = Join-Path $env:APPDATA 'deepseek-harness-desktop\server.json'
Remove-Item $srvPath -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'deepseek-harness-desktop\backend-booting.json') -ErrorAction SilentlyContinue
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -ArgumentList '.', '--backend-only' -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(40)
$state = $null
while ((Get-Date) -lt $deadline -and -not $state) {
  if (Test-Path $srvPath) { $state = Get-Content $srvPath -Raw }
  else { Start-Sleep -Milliseconds 250 }
}
$sw.Stop()
$bootMarker = Test-Path (Join-Path $env:APPDATA 'deepseek-harness-desktop\backend-booting.json')
'elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's'
'state=' + $state
'bootingMarkerLeft=' + $bootMarker
'exited=' + $p.HasExited
if (-not $p.HasExited) { $null = $p.WaitForExit(10000) }
'exitedAfterWait=' + $p.HasExited
if ($state) {
  $url = ($state | ConvertFrom-Json).url
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; 'httpStatus=' + $r.StatusCode } catch { 'httpFail=' + $_.Exception.Message }
  $pid2 = ($state | ConvertFrom-Json).pid
  $alive = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  'backendAlive=' + ($null -ne $alive)
}