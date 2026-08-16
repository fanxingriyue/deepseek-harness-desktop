$ErrorActionPreference = 'Continue'
$repo = 'D:\deepseek\deepseek-harness-desktop'
Remove-Item (Join-Path $env:APPDATA 'deepseek-harness-desktop\server.json') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'deepseek-harness-desktop\backend-booting.json') -ErrorAction SilentlyContinue
Remove-Item $env:TEMP\dsh-desktop-smoke.json -ErrorAction SilentlyContinue
$stale = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*deepseek-harness-desktop*' }
'stale desktop procs: ' + $stale.Count
$stale | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine.Substring(0,[Math]::Min(80,$_.CommandLine.Length)) }
$env:DSH_DESKTOP_SMOKE = '1'
Remove-Item Env:DSH_DESKTOP_SMOKE_KEEP -ErrorAction SilentlyContinue
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -ArgumentList '.', '--no-sandbox' -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(40)
$smoke = $null
while ((Get-Date) -lt $deadline -and -not $smoke) {
  if (Test-Path $env:TEMP\dsh-desktop-smoke.json) { $smoke = Get-Content $env:TEMP\dsh-desktop-smoke.json -Raw }
  elseif ($p.HasExited) { break }
  else { Start-Sleep -Milliseconds 200 }
}
$sw.Stop()
'elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's'
'smoke=' + $smoke
if (-not $p.HasExited) { $null = $p.WaitForExit(15000) }
'exited=' + $p.HasExited
Start-Sleep -Milliseconds 500
$left = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*vendor*dsh*bin.js*' }
'vendorBackendsLeft=' + $left.Count