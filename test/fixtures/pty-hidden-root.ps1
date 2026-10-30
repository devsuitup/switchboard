$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:FIXTURE_NODE
$start.Arguments = '"' + $env:FIXTURE_CHILD + '" "' + $env:FIXTURE_PIDS + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
$child.Dispose()
Start-Sleep -Seconds 25
