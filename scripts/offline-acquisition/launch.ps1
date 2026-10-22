$ErrorActionPreference = 'Stop'
# Resolve only the setup-node executable; child process inherits no environment.
$node = (Get-Command node.exe -CommandType Application).Source
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.UseShellExecute = $false
$start.WorkingDirectory = Join-Path $env:GITHUB_WORKSPACE 'controls'
$start.ArgumentList.Add('scripts/offline-acquisition/runner.mjs')
$start.Environment.Clear()
foreach ($name in @('SystemRoot', 'RUNNER_TEMP', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GITHUB_WORKSPACE')) {
    $value = [System.Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing host fact: $name" }
    $start.Environment[$name] = $value
}
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
