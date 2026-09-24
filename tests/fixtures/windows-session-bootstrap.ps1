# Test-only ACL/reparse inspector. It never emits SIDs or descriptor bytes.
param(
	[Parameter(Mandatory = $true)][ValidateSet('capture', 'equals', 'measure', 'add-extra-ace', 'junction', 'rename', 'replace-identical', 'hardlink', 'append', 'exclusive-open')][string]$Mode,
	[Parameter(Mandatory = $true)][string]$Path,
	[string]$BaselinePath,
	[string]$Target
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Write-Result([hashtable]$result) { [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)) }
function Get-ReplacementHResult($errorRecord) {
	if ($null -eq $errorRecord) { return $null }
	$exceptionProperty = $errorRecord.PSObject.Properties['Exception']
	if ($null -eq $exceptionProperty -or $exceptionProperty.Value -isnot [Exception]) { return $null }
	try { $baseException = $exceptionProperty.Value.GetBaseException() } catch { return $null }
	if ($baseException -isnot [IO.IOException] -and $baseException -isnot [UnauthorizedAccessException] -and $baseException -isnot [Security.SecurityException] -and $baseException -isnot [ComponentModel.Win32Exception]) { return $null }
	$hresultProperty = $baseException.PSObject.Properties['HResult']
	if ($null -eq $hresultProperty -or $hresultProperty.Value -isnot [int] -or $hresultProperty.Value -eq 0) { return $null }
	return [int]$hresultProperty.Value
}
try {
	if ($Mode -eq 'capture') {
		if ([string]::IsNullOrEmpty($BaselinePath)) { throw 'baseline-required' }
		$acl = Get-Acl -LiteralPath $Path
		[IO.File]::WriteAllBytes($BaselinePath, $acl.GetSecurityDescriptorBinaryForm())
		Write-Result @{ ok = $true; equal = $true }
		exit 0
	}
	if ($Mode -eq 'equals') {
		if ([string]::IsNullOrEmpty($BaselinePath) -or -not [IO.File]::Exists($BaselinePath)) { throw 'baseline-required' }
		$actual = (Get-Acl -LiteralPath $Path).GetSecurityDescriptorBinaryForm()
		$expected = [IO.File]::ReadAllBytes($BaselinePath)
		Write-Result @{ ok = $true; equal = ([Convert]::ToBase64String($actual) -ceq [Convert]::ToBase64String($expected)) }
		exit 0
	}
	if ($Mode -eq 'add-extra-ace') {
		$acl = Get-Acl -LiteralPath $Path
		$authenticatedUsers = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::AuthenticatedUserSid, $null)
		$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($authenticatedUsers, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow))
		Set-Acl -LiteralPath $Path -AclObject $acl
		Write-Result @{ ok = $true; changed = $true }
		exit 0
	}
	if ($Mode -eq 'replace-identical') {
		$temp = "$Path.replacement"
		$replacementStage = 'replacement-copy'
		try {
			[IO.File]::Copy($Path, $temp, $true)
			$replacementStage = 'replacement-acl'
			Set-Acl -LiteralPath $temp -AclObject (Get-Acl -LiteralPath $Path)
			$replacementStage = 'replacement-rename'
			Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowsSessionBootstrapFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string destination, uint flags);
}
'@ -ErrorAction Stop
			$original = "$Path.original-$([Guid]::NewGuid().ToString('N'))"
			$movedOriginal = [WindowsSessionBootstrapFixture]::MoveFileEx($Path, $original, 0)
			if (-not $movedOriginal) {
				$replacementCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
				$replacementCodeKind = if ($replacementCode -eq 0) { 'unknown' } else { 'win32' }
				if ($replacementCodeKind -eq 'unknown') { $replacementCode = $null }
				Write-Result @{ ok = $false; kind = 'windows-session-bootstrap-fixture-failure'; stage = $replacementStage; codeKind = $replacementCodeKind; code = $replacementCode }
				exit 1
			}
			$movedReplacement = [WindowsSessionBootstrapFixture]::MoveFileEx($temp, $Path, 0)
			if (-not $movedReplacement) {
				$replacementCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
				$replacementCodeKind = if ($replacementCode -eq 0) { 'unknown' } else { 'win32' }
				if ($replacementCodeKind -eq 'unknown') { $replacementCode = $null }
				Write-Result @{ ok = $false; kind = 'windows-session-bootstrap-fixture-failure'; stage = $replacementStage; codeKind = $replacementCodeKind; code = $replacementCode }
				exit 1
			}
		} catch {
			$replacementCode = Get-ReplacementHResult $_
			$replacementCodeKind = if ($null -eq $replacementCode) { 'unknown' } else { 'hresult' }
			Write-Result @{ ok = $false; kind = 'windows-session-bootstrap-fixture-failure'; stage = $replacementStage; codeKind = $replacementCodeKind; code = $replacementCode }
			exit 1
		}
		Write-Result @{ ok = $true; replaced = $true }
		exit 0
	}
	if ($Mode -eq 'hardlink') {
		if ([string]::IsNullOrEmpty($Target)) { throw 'target-required' }
		Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowsSessionBootstrapHardlinkFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateHardLink(string name, string existing, IntPtr security);
}
'@ -ErrorAction Stop
		if (-not [WindowsSessionBootstrapHardlinkFixture]::CreateHardLink($Target, $Path, [IntPtr]::Zero)) { throw 'hardlink-failed' }
		Write-Result @{ ok = $true; hardlink = $true }
		exit 0
	}
	if ($Mode -eq 'exclusive-open') {
		$stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
		try { Write-Result @{ ok = $true; exclusive = $true } } finally { $stream.Dispose() }
		exit 0
	}
	if ($Mode -eq 'append') {
		$bytes = [Text.Encoding]::UTF8.GetBytes(('x' * 8193))
		$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
		$stream = [IO.FileStream]::new($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, $share)
		try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush(); Write-Result @{ ok = $true; appended = $true } } finally { $stream.Dispose() }
		exit 0
	}
	if ($Mode -eq 'rename') {
		if ([string]::IsNullOrEmpty($Target)) { throw 'target-required' }
		[IO.Directory]::Move($Path, $Target)
		Write-Result @{ ok = $true; renamed = $true }
		exit 0
	}
	if ($Mode -eq 'junction') {
		if ([string]::IsNullOrEmpty($Target)) { throw 'target-required' }
		New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
		Write-Result @{ ok = $true; reparse = $true }
		exit 0
	}
	$item = Get-Item -LiteralPath $Path -Force
	$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	$acl = Get-Acl -LiteralPath $Path
	$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
	$ownerCurrent = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid
	$private = $ownerCurrent -and $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and -not $rules[0].IsInherited -and $rules[0].IdentityReference.Value -eq $sid -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and [int64]$rules[0].FileSystemRights -eq [int64][Security.AccessControl.FileSystemRights]::FullControl
	Write-Result @{ ok = $true; directory = $item.PSIsContainer; reparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); ownerCurrent = $ownerCurrent; privateBoundary = $private }
} catch { Write-Result @{ ok = $false }; exit 1 }
