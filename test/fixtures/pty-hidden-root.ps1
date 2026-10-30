$ErrorActionPreference = 'Stop'
if ($env:FIXTURE_GATE) {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $env:FIXTURE_GATE)) {
    if ([DateTime]::UtcNow -gt $deadline) { exit 1 }
    Start-Sleep -Milliseconds 25
  }
}
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:FIXTURE_NODE
$start.Arguments = '"' + $env:FIXTURE_CHILD + '" "' + $env:FIXTURE_PIDS + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
$child.Dispose()
Start-Sleep -Seconds 25
