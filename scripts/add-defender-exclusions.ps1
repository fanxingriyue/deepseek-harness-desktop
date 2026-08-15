# Adds Windows Defender exclusions for the DeepSeek Harness desktop app
# directories so the ~34k-file bundled runtime is not re-scanned on access.
$ErrorActionPreference = "SilentlyContinue"

$paths = @(
  'D:\deepseek\deepseek-harness-desktop\vendor',
  'C:\Users\LENOVO\.dsh',
  (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness-desktop')
)

Add-MpPreference -ExclusionPath $paths

$result = (Get-MpPreference | Select-Object -ExpandProperty ExclusionPath) -join [Environment]::NewLine
$result | Out-File -FilePath (Join-Path $env:TEMP "defender-excl-result.txt") -Encoding utf8
