$ErrorActionPreference = 'Continue'
$repo = 'D:\deepseek\deepseek-harness-desktop'
$srvPath = Join-Path $env:APPDATA 'deepseek-harness-desktop\server.json'
$bootPath = Join-Path $env:APPDATA 'deepseek-harness-desktop\backend-booting.json'
Remove-Item $srvPath, $bootPath -ErrorAction SilentlyContinue
Remove-Item $env:TEMP\dsh-desktop-smoke.json -ErrorAction SilentlyContinue
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'

# 1) start prewarm in background
$pre = Start-Process -FilePath $exe -ArgumentList '.', '--backend-only' -WorkingDirectory $repo -PassThru -WindowStyle Hidden

# 2) 1s later, user launches the app (smoke mode)
Start-Sleep -Milliseconds 1000
$env:DSH_DESKTOP_SMOKE = '1'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$app = Start-Process -FilePath $exe -ArgumentList '.', '--no-sandbox' -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(45)
$smoke = $null
while ((Get-Date) -lt $deadline -and -not $smoke) {
  if (Test-Path $env:TEMP\dsh-desktop-smoke.json) { $smoke = Get-Content $env:TEMP\dsh-desktop-smoke.json -Raw }
  else { Start-Sleep -Milliseconds 200 }
}
$sw.Stop()
'appElapsed=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's'
'smoke=' + $smoke
'prewarmExited=' + $pre.HasExited
if (-not $app.HasExited) { $null = $app.WaitForExit(15000) }
'appExited=' + $app.HasExited
Start-Sleep -Milliseconds 800

# after smoke quit (kills backend), count vendor backends: must be 0
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vendor*dsh*bin.js*' }
'vendorBackendsLeft=' + $procs.Count
'serverJsonLeft=' + (Test-Path $srvPath)
'bootingMarkerLeft=' + (Test-Path $bootPath)
'smokeUrl=' + ((Get-Content $env:TEMP\dsh-desktop-smoke.json -Raw | ConvertFrom-Json).url)