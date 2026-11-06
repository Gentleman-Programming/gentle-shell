# Test-only, nonconnecting probe; never accepts a client or changes pipe capacity.
param([Parameter(Mandatory = $true)][string]$Endpoint)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
	Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class WindowsPipeAvailability {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool WaitNamedPipe(string name, uint timeout);
  public static int Probe(string name) {
    return WaitNamedPipe(name, 1) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@ -ErrorAction Stop
	[Console]::Out.WriteLine('{"ready":true}')
	while (($line = [Console]::In.ReadLine()) -ne $null) {
		if ($line -cne 'probe') { throw 'invalid-probe-command' }
		$code = [WindowsPipeAvailability]::Probe($Endpoint)
		[Console]::Out.WriteLine((@{ available = ($code -eq 0); code = $code } | ConvertTo-Json -Compress))
	}
	exit 0
} catch {
	[Console]::Error.WriteLine('Windows pipe availability probe failed')
	exit 1
}
