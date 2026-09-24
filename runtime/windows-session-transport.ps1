# PS5.1 helper-owned Windows presence metadata boundary. It intentionally has
# no pipe server: start remains partial and publication never advertises a
# fabricated active listener.
# Native definitions adapted from windows-native-boundary-clean/tests/windows-native-boundary/native.ps1
# at c59e1598 (NtCreateFile rooted opens, GetSecurityInfo, and ABI layout).
# API provenance: NtCreateFile / OBJECT_ATTRIBUTES / NtQueryDirectoryFile are
# documented by Microsoft Win32/WDK; this helper has no external binary dependency.
[Console]::Out.WriteLine('{"event":"startup-marker","marker":"script-entered"}')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$maxControlBytes = 16384
$maxBootstrapDiagnosticText = 4096
$nativeReady = $false

function Add-BootstrapDiagnosticText([System.Text.StringBuilder]$builder, [object]$value) {
	if ($null -eq $value -or $builder.Length -ge $maxBootstrapDiagnosticText) { return }
	$text = [string]$value
	$remaining = $maxBootstrapDiagnosticText - $builder.Length
	if ($text.Length -gt $remaining) { $text = $text.Substring(0, $remaining) }
	[void]$builder.Append($text)
}

function Get-BootstrapLanguageMode {
	try {
		switch ([string]$ExecutionContext.SessionState.LanguageMode) {
			'FullLanguage' { return 'full' }
			'ConstrainedLanguage' { return 'constrained' }
			'RestrictedLanguage' { return 'restricted' }
			'NoLanguage' { return 'no-language' }
			default { return 'unknown' }
		}
	} catch { return 'unknown' }
}

function Get-BootstrapProperty([object]$value, [string]$name) {
	try {
		if ($null -eq $value) { return $null }
		$property = $value.PSObject.Properties[$name]
		if ($null -eq $property) { return $null }
		return $property.Value
	} catch { return $null }
}

function ConvertTo-BootstrapDiagnosticRecord([object]$entry) {
	$candidate = $entry
	for ($depth = 0; $depth -lt 8 -and $null -ne $candidate; $depth++) {
		if ($candidate -is [System.Management.Automation.ErrorRecord]) {
			$fqid = Get-BootstrapProperty $candidate 'FullyQualifiedErrorId'
			$categoryInfo = Get-BootstrapProperty $candidate 'CategoryInfo'
			$category = Get-BootstrapProperty $categoryInfo 'Category'
			$errorDetails = Get-BootstrapProperty $candidate 'ErrorDetails'
			$errorDetailsMessage = Get-BootstrapProperty $errorDetails 'Message'
			$exception = Get-BootstrapProperty $candidate 'Exception'
			$targetObject = Get-BootstrapProperty $candidate 'TargetObject'
			return [pscustomobject]@{
				FullyQualifiedErrorId = if ($fqid -is [string]) { $fqid } else { $null }
				Category = if ($category -is [System.Management.Automation.ErrorCategory]) { $category } else { $null }
				ErrorDetailsMessage = if ($errorDetailsMessage -is [string]) { $errorDetailsMessage } else { $null }
				Exception = if ($exception -is [System.Exception]) { $exception } else { $null }
				TargetObject = if ($targetObject -is [System.CodeDom.Compiler.CompilerError]) { $targetObject } else { $null }
			}
		}
		$wrapped = Get-BootstrapProperty $candidate 'ErrorRecord'
		if ($wrapped -is [System.Management.Automation.ErrorRecord]) {
			$candidate = $wrapped
			continue
		}
		if ($candidate -is [System.Exception]) {
			return [pscustomobject]@{ FullyQualifiedErrorId = $null; Category = $null; ErrorDetailsMessage = $null; Exception = $candidate }
		}
		$candidate = $wrapped
	}
	return $null
}

function Get-BootstrapCompilerErrorCode([object]$target) {
	try {
		if ($target -isnot [System.CodeDom.Compiler.CompilerError]) { return $null }
		$errorNumber = Get-BootstrapProperty $target 'ErrorNumber'
		if ($errorNumber -is [string] -and $errorNumber -cmatch '\ACS[0-9]{4}\z') { return $errorNumber }
	} catch {}
	return $null
}

function Get-BootstrapAddTypeReason([object]$record) {
	$fqid = Get-BootstrapProperty $record 'FullyQualifiedErrorId'
	if ($fqid -isnot [string]) { return 'unknown' }
	$id = [regex]::Match($fqid, '^[^,]+').Value
	switch ($id) {
		'SOURCE_CODE_ERROR' { return 'source-code-error' }
		'TYPE_ALREADY_EXISTS' { return 'type-already-exists' }
		default { return 'unknown' }
	}
}

function Get-BootstrapDiagnosticCategory([object]$record) {
	$recordCategory = Get-BootstrapProperty $record 'Category'
	switch ($recordCategory) {
		([System.Management.Automation.ErrorCategory]::InvalidArgument) { return 'argument' }
		([System.Management.Automation.ErrorCategory]::InvalidOperation) { return 'invalid-operation' }
		([System.Management.Automation.ErrorCategory]::NotImplemented) { return 'not-supported' }
		([System.Management.Automation.ErrorCategory]::SecurityError) { return 'security' }
	}
	$exception = Get-BootstrapProperty $record 'Exception'
	for ($depth = 0; $depth -lt 8 -and $exception -is [System.Exception]; $depth++) {
		if ($exception -is [System.ArgumentException]) { return 'argument' }
		if ($exception -is [System.InvalidOperationException]) { return 'invalid-operation' }
		if ($exception -is [System.NotSupportedException]) { return 'not-supported' }
		if ($exception -is [System.Security.SecurityException] -or $exception -is [System.UnauthorizedAccessException]) { return 'security' }
		if ($exception -is [System.IO.FileLoadException] -or $exception -is [System.IO.FileNotFoundException] -or $exception -is [System.BadImageFormatException]) { return 'assembly-load' }
		if ($exception -is [System.TypeLoadException] -or $exception -is [System.Reflection.ReflectionTypeLoadException]) { return 'type-load' }
		$next = Get-BootstrapProperty $exception 'InnerException'
		$exception = if ($next -is [System.Exception]) { $next } else { $null }
	}
	return 'other'
}

function Write-BootstrapDiagnosticFallback {
	try {
		[Console]::Error.WriteLine(([pscustomobject]@{ kind = 'windows-session-bootstrap-diagnostic'; category = 'other'; compilerCodes = @(); reason = 'unknown'; languageMode = 'unknown' } | ConvertTo-Json -Compress))
	} catch {}
}

function Write-BootstrapDiagnostic([object[]]$records) {
	try {
		$category = 'other'
		$reason = 'unknown'
		$compilerCodes = [System.Collections.Generic.List[string]]::new()
		$seenCompilerCodes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
		$text = [System.Text.StringBuilder]::new()
		$captured = @()
		foreach ($entry in $records) {
			if ($captured.Count -ge 8) { break }
			$record = ConvertTo-BootstrapDiagnosticRecord $entry
			if ($null -ne $record) { $captured += $record }
		}
		foreach ($record in $captured) {
			if ($category -eq 'other') { $category = Get-BootstrapDiagnosticCategory $record }
			if ($reason -eq 'unknown') { $reason = Get-BootstrapAddTypeReason $record }
			Add-BootstrapDiagnosticText $text (Get-BootstrapProperty $record 'FullyQualifiedErrorId')
			Add-BootstrapDiagnosticText $text (Get-BootstrapProperty $record 'ErrorDetailsMessage')
		}
		foreach ($record in $captured) {
			$code = Get-BootstrapCompilerErrorCode (Get-BootstrapProperty $record 'TargetObject')
			if ($code -is [string] -and $seenCompilerCodes.Add($code) -and $compilerCodes.Count -lt 8) { $compilerCodes.Add($code) }
		}
		foreach ($record in $captured) {
			$exception = Get-BootstrapProperty $record 'Exception'
			for ($depth = 0; $depth -lt 8 -and $exception -is [System.Exception]; $depth++) {
				$message = Get-BootstrapProperty $exception 'Message'
				if ($message -is [string]) { Add-BootstrapDiagnosticText $text $message }
				$next = Get-BootstrapProperty $exception 'InnerException'
				$exception = if ($next -is [System.Exception]) { $next } else { $null }
			}
		}
		foreach ($match in [regex]::Matches($text.ToString(), 'CS[0-9]{4}')) {
			$code = $match.Value
			if ($seenCompilerCodes.Add($code) -and $compilerCodes.Count -lt 8) { $compilerCodes.Add($code) }
		}
		if ($compilerCodes.Count -gt 0) {
			$category = 'compiler'
			if ($reason -eq 'unknown') { $reason = 'compiler-errors' }
		}
		$languageMode = Get-BootstrapLanguageMode
		[Console]::Error.WriteLine(([pscustomobject]@{ kind = 'windows-session-bootstrap-diagnostic'; category = $category; compilerCodes = @($compilerCodes.ToArray()); reason = $reason; languageMode = $languageMode } | ConvertTo-Json -Compress))
	} catch { Write-BootstrapDiagnosticFallback }
}

$addTypeErrors = @()
try {
	Add-Type -ErrorAction Stop -ErrorVariable +addTypeErrors -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.IO.Pipes;

public sealed class BootstrapFailure : Exception {
  public readonly string Code, Stage;
  public readonly uint? NtStatus;
  public BootstrapFailure(string code, string stage, uint? ntStatus) { Code = code; Stage = stage; NtStatus = ntStatus; }
}

public static class WindowsSessionBootstrap {
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  // FILE_ID_BOTH_DIR_INFORMATION layout from Microsoft's ntifs.h / winternl documentation.
  [StructLayout(LayoutKind.Sequential)] struct FILE_ID_BOTH_DIR_HEADER {
    public uint NextEntryOffset, FileIndex; public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime, EndOfFile, AllocationSize;
    public uint FileAttributes, FileNameLength, EaSize; public byte ShortNameLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=24)] public byte[] ShortName; public long FileId; public ushort FileName;
  }
  struct OpenResult { public IntPtr Handle; public uint Status; public OpenResult(IntPtr handle, uint status) { Handle = handle; Status = status; } }

  const uint OBJ_CASE_INSENSITIVE = 0x40, OBJ_DONT_REPARSE = 0x1000;
  const uint FILE_LIST_DIRECTORY = 1, FILE_TRAVERSE = 0x20, FILE_READ_DATA = 1, FILE_WRITE_DATA = 2, FILE_READ_ATTRIBUTES = 0x80, READ_CONTROL = 0x00020000, DELETE = 0x00010000, SYNCHRONIZE = 0x00100000;
  // Directory pins omit delete sharing; a retained published file permits replacement.
      const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint FILE_OPEN = 1, FILE_CREATE = 2, FILE_DIRECTORY_FILE = 1, FILE_NON_DIRECTORY_FILE = 0x40, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint SE_FILE_OBJECT = 1, OWNER_SECURITY_INFORMATION = 1, DACL_SECURITY_INFORMATION = 4;
  const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034, STATUS_OBJECT_NAME_COLLISION = 0xC0000035;
  const int FileIdBothDirectoryInformation = 37;
  static readonly object Gate = new object();
  static readonly object OutputGate = new object();
  static readonly List<IntPtr> Handles = new List<IntPtr>();
  static IntPtr Presence = IntPtr.Zero;
  static string InitializationStage = "unknown";
  static uint? InitializationNtStatus = null;
  static OwnedListener Listener = null;

  [DllImport("ntdll.dll", CallingConvention=CallingConvention.Winapi)] static extern uint NtCreateFile(out IntPtr fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll", CallingConvention=CallingConvention.Winapi)] static extern uint NtQueryDirectoryFile(IntPtr fileHandle, IntPtr eventHandle, IntPtr apcRoutine, IntPtr apcContext, out IO_STATUS_BLOCK ioStatusBlock, IntPtr fileInformation, uint length, int fileInformationClass, bool returnSingleEntry, IntPtr fileName, bool restartScan);
      [DllImport("ntdll.dll", CallingConvention=CallingConvention.Winapi)] static extern uint NtSetInformationFile(IntPtr fileHandle, out IO_STATUS_BLOCK ioStatusBlock, IntPtr fileInformation, uint length, int fileInformationClass);
      [DllImport("ntdll.dll", CallingConvention=CallingConvention.Winapi)] static extern uint RtlNtStatusToDosError(uint status);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
      [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] buffer, uint length, out uint read, IntPtr overlapped);
      [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] buffer, uint length, out uint written, IntPtr overlapped);
      [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, IntPtr securityAttributes);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeNameForVolumeMountPoint(string rootPathName, System.Text.StringBuilder volumeName, uint cchBufferLength);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformation(string rootPathName, IntPtr volumeNameBuffer, uint volumeNameSize, out uint volumeSerialNumber, out uint maximumComponentLength, out uint fileSystemFlags, IntPtr fileSystemNameBuffer, uint fileSystemNameSize);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  static void Fail(string code) { throw new BootstrapFailure(code, InitializationStage, InitializationNtStatus); }
  static void SetStage(string stage) { InitializationStage = stage; InitializationNtStatus = null; }
  static void SetNtStatus(uint status) { InitializationNtStatus = status; }
  static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
  public static void WriteControl(string line) { lock (OutputGate) { Console.Out.WriteLine(line); } }
  static IntPtr Unicode(string value, out IntPtr chars) {
    chars = Marshal.StringToHGlobalUni(value); var text = new UNICODE_STRING();
    text.Length = checked((ushort)(value.Length * 2)); text.MaximumLength = text.Length; text.Buffer = chars;
    IntPtr valuePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING))); Marshal.StructureToPtr(text, valuePointer, false); return valuePointer;
  }
  static OpenResult Open(IntPtr root, string name, bool privateDirectory, bool create, byte[] descriptor) {
    IntPtr chars = IntPtr.Zero, unicode = IntPtr.Zero, security = IntPtr.Zero, handle = IntPtr.Zero;
    try {
      unicode = Unicode(name, out chars); var attributes = new OBJECT_ATTRIBUTES();
      attributes.Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)); attributes.RootDirectory = root; attributes.ObjectName = unicode;
      attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
      if (create) { if (descriptor == null || descriptor.Length == 0) Fail("unavailable"); security = Marshal.AllocHGlobal(descriptor.Length); Marshal.Copy(descriptor, 0, security, descriptor.Length); attributes.SecurityDescriptor = security; }
      uint access = SYNCHRONIZE | FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
      if (privateDirectory) access |= FILE_LIST_DIRECTORY | READ_CONTROL;
      IO_STATUS_BLOCK statusBlock; uint status = NtCreateFile(out handle, access, ref attributes, out statusBlock, IntPtr.Zero, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, create ? FILE_CREATE : FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, IntPtr.Zero, 0);
      if (status != 0) { Close(handle); return new OpenResult(IntPtr.Zero, status); }
      return new OpenResult(handle, status);
    } finally { if (security != IntPtr.Zero) Marshal.FreeHGlobal(security); if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars); }
  }
  // OBJ_DONT_REPARSE returns STATUS_REPARSE_POINT_ENCOUNTERED (0xC000050B) before file-system parsing.
  // The canonical Volume GUID name is returned by the OS for the validated drive root, so only this opener
  // permits that Object Manager alias resolution; every user-derived component still uses Open above.
  static OpenResult OpenVolume(string volumePath) {
    IntPtr chars = IntPtr.Zero, unicode = IntPtr.Zero, handle = IntPtr.Zero;
    try {
      unicode = Unicode(volumePath, out chars); var attributes = new OBJECT_ATTRIBUTES();
      attributes.Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)); attributes.RootDirectory = IntPtr.Zero; attributes.ObjectName = unicode;
      attributes.Attributes = OBJ_CASE_INSENSITIVE;
      uint access = SYNCHRONIZE | FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
      IO_STATUS_BLOCK statusBlock; uint status = NtCreateFile(out handle, access, ref attributes, out statusBlock, IntPtr.Zero, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, IntPtr.Zero, 0);
      if (status != 0) { Close(handle); return new OpenResult(IntPtr.Zero, status); }
      return new OpenResult(handle, status);
    } finally { if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars); }
  }
  static void AssertDirectory(IntPtr handle) {
    if (handle == IntPtr.Zero) Fail("unsafe");
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, out info)) Fail("unsafe");
    if ((info.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != FILE_ATTRIBUTE_DIRECTORY) Fail("unsafe");
  }
  static IntPtr RequireVolumeOpen(string volumePath, uint volumeSerial) {
    OpenResult result = OpenVolume(volumePath);
    if (result.Handle == IntPtr.Zero) { SetNtStatus(result.Status); Fail(result.Status == STATUS_OBJECT_NAME_NOT_FOUND ? "unavailable" : "unsafe"); }
    try {
      AssertDirectory(result.Handle);
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(result.Handle, out info) || info.VolumeSerialNumber != volumeSerial) Fail("unsafe");
      return result.Handle;
    } catch { Close(result.Handle); throw; }
  }
  static IntPtr RequireOpen(IntPtr root, string component, bool privateDirectory) {
    OpenResult result = Open(root, component, privateDirectory, false, null);
    if (result.Handle == IntPtr.Zero) { SetNtStatus(result.Status); Fail(result.Status == STATUS_OBJECT_NAME_NOT_FOUND ? "unavailable" : "unsafe"); }
    try { AssertDirectory(result.Handle); return result.Handle; } catch { Close(result.Handle); throw; }
  }
  static void AssertOwned(IntPtr handle, string sid) {
    IntPtr owner, group, dacl, sacl, descriptor = IntPtr.Zero;
    uint status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0 || descriptor == IntPtr.Zero) Fail("unsafe");
    try {
      uint length = GetSecurityDescriptorLength(descriptor); if (length == 0 || length > 65536) Fail("unsafe");
      byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, (int)length); var raw = new RawSecurityDescriptor(bytes, 0);
      if (raw.Owner == null || raw.Owner.Value != sid || (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || raw.DiscretionaryAcl == null || raw.DiscretionaryAcl.Count != 1) Fail("unsafe");
      CommonAce ace = raw.DiscretionaryAcl[0] as CommonAce;
      if (ace == null || ace.IsCallback || ace.AceFlags != AceFlags.None || ace.AceQualifier != AceQualifier.AccessAllowed || ace.IsInherited || ace.SecurityIdentifier == null || ace.SecurityIdentifier.Value != sid || ace.AccessMask != 0x1F01FF) Fail("unsafe");
    } finally { LocalFree(descriptor); }
  }
  static IntPtr CreateOrOpenOwned(IntPtr parent, string name, byte[] descriptor, string sid, string createStage, string assertStage) {
    SetStage(createStage);
    OpenResult created = Open(parent, name, true, true, descriptor); IntPtr handle = created.Handle;
    if (handle == IntPtr.Zero) {
      if (created.Status != STATUS_OBJECT_NAME_COLLISION) { SetNtStatus(created.Status); Fail(created.Status == STATUS_OBJECT_NAME_NOT_FOUND ? "unavailable" : "unsafe"); }
      handle = RequireOpen(parent, name, true);
    }
    try { SetStage(assertStage); AssertDirectory(handle); AssertOwned(handle, sid); return handle; } catch { Close(handle); throw; }
  }
  static string[] Components(string agentHome) {
    if (String.IsNullOrEmpty(agentHome) || agentHome.Length > 4096 || !Regex.IsMatch(agentHome, @"^[A-Za-z]:\\(?:[^\\]+\\)*[^\\]+$") /* "^[A-Za-z]:\\\\(?:[^\\\\]+\\\\)*[^\\\\]+$")) */ ) Fail("invalid");
    if (agentHome.StartsWith("\\\\") || agentHome.IndexOf(':', 2) >= 0 || agentHome.IndexOf("\0") >= 0) Fail("invalid");
    string[] parts = agentHome.Substring(3).Split('\\'); if (parts.Length == 0) Fail("invalid");
    foreach (string part in parts) if (part.Length == 0 || part == "." || part == ".." || part.IndexOf(':') >= 0 || part.IndexOfAny(new char[] {'/', '\0'}) >= 0) Fail("invalid");
    return parts;
  }
  static string VolumePath(string agentHome, out uint volumeSerial) {
    var name = new System.Text.StringBuilder(128); string mount = agentHome.Substring(0, 3);
    if (!GetVolumeNameForVolumeMountPoint(mount, name, (uint)name.Capacity)) Fail("unavailable");
    string volume = name.ToString(); if (!Regex.IsMatch(volume, @"^\\\\\?\\Volume\{[0-9A-Fa-f-]+\}\\$") /* "^\\\\\\?\\\\Volume\\{[0-9A-Fa-f-]+\\}\\\\$")) */ ) Fail("unsafe");
    uint maximumComponentLength, fileSystemFlags;
    if (!GetVolumeInformation(volume, IntPtr.Zero, 0, out volumeSerial, out maximumComponentLength, out fileSystemFlags, IntPtr.Zero, 0)) Fail("unavailable");
    return @"\??\" + volume.Substring(4);
  }
  // The helper keeps this capability local. Publication/list RPCs are intentionally absent.
  static string[] EnumeratePinned(IntPtr directory) {
    const int MaxEntries = 64, MaxBytes = 8192; const uint STATUS_NO_MORE_FILES = 0x80000006;
        int Header = Marshal.OffsetOf(typeof(FILE_ID_BOTH_DIR_HEADER), "FileName").ToInt32(); if (Header <= 0 || Header >= MaxBytes) Fail("unavailable"); var names = new List<string>(); IntPtr buffer = Marshal.AllocHGlobal(MaxBytes);
    try {
      bool restart = true;
      for (;;) {
        IO_STATUS_BLOCK io; uint status = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buffer, MaxBytes, FileIdBothDirectoryInformation, false, IntPtr.Zero, restart); restart = false;
        if (status == STATUS_NO_MORE_FILES) return names.ToArray();
            if (status != 0) Fail("unsafe");
            ulong available64 = io.Information.ToUInt64(); if (available64 == 0 || available64 > MaxBytes) Fail("unsafe"); int available = (int)available64;
        int offset = 0;
        while (offset < available) {
              if (available - offset < Header) Fail("unsafe");
          int next = Marshal.ReadInt32(buffer, offset), nameLength = Marshal.ReadInt32(buffer, offset + 60);
              int recordLength = next == 0 ? available - offset : next;
          if (recordLength < Header || recordLength > available - offset || (next != 0 && (next & 7) != 0) || nameLength < 0 || (nameLength & 1) != 0 || nameLength > recordLength - Header) Fail("unsafe");
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + Header), nameLength / 2);
          if (String.IsNullOrEmpty(name) || name.IndexOfAny(new char[] {'\\', '/', ':', '\0'}) >= 0) Fail("unsafe");
          if (name != "." && name != "..") { if (names.Count >= MaxEntries) Fail("busy"); names.Add(name); }
              if (next == 0) { offset = available; } else { offset += next; }
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static int EnumeratePresence() { lock (Gate) { if (Presence == IntPtr.Zero) Fail("unavailable"); return EnumeratePinned(Presence).Length; } }
      public sealed class PresenceRecord {
        public readonly string SessionId, Endpoint, Token; public readonly long CreatedAt;
        public PresenceRecord(string sessionId, string endpoint, string token, long createdAt) { SessionId = sessionId; Endpoint = endpoint; Token = token; CreatedAt = createdAt; }
      }
      static readonly string PipePrefix = @"\\.\pipe\gentle-pi-";
      const int FileDispositionInformation = 13, MaxOwnedPublications = 64;
      struct RecordIdentity { public uint Volume; public uint IndexHigh, IndexLow; public RecordIdentity(BY_HANDLE_FILE_INFORMATION info) { Volume = info.VolumeSerialNumber; IndexHigh = info.FileIndexHigh; IndexLow = info.FileIndexLow; } public bool Equals(RecordIdentity other) { return Volume == other.Volume && IndexHigh == other.IndexHigh && IndexLow == other.IndexLow; } }
      sealed class OwnedPublication { public readonly PresenceRecord Record; public readonly RecordIdentity Identity; public readonly string Sid; public SafeFileHandle Handle; public OwnedPublication(PresenceRecord record, RecordIdentity identity, string sid, IntPtr handle) { Record = record; Identity = identity; Sid = sid; Handle = new SafeFileHandle(handle, true); } public void Dispose() { if (Handle != null) { Handle.Dispose(); Handle = null; } } }
      static readonly List<OwnedPublication> OwnedPublications = new List<OwnedPublication>();
      static bool SameRecord(PresenceRecord left, string sessionId, string endpoint, long createdAt) { return left.SessionId == sessionId && left.Endpoint == endpoint && left.CreatedAt == createdAt; }
      static OwnedPublication FindOwned(string sessionId, string endpoint, long createdAt) { foreach (OwnedPublication owned in OwnedPublications) if (SameRecord(owned.Record, sessionId, endpoint, createdAt)) return owned; return null; }
      static void RequirePresence() { if (Presence == IntPtr.Zero) Fail("unavailable"); }
      static void ValidateRecord(string sessionId, string endpoint, long createdAt, out string token) {
        token = null;
        if (String.IsNullOrEmpty(sessionId) || !Regex.IsMatch(sessionId, "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$") || createdAt < 0 || createdAt > 9007199254740991L || String.IsNullOrEmpty(endpoint) || !endpoint.StartsWith(PipePrefix, StringComparison.Ordinal)) Fail("invalid");
        token = endpoint.Substring(PipePrefix.Length); if (!Regex.IsMatch(token, "^[0-9a-f]{32}$")) Fail("invalid");
      }
      static string RecordName(string sessionId, string token) { return sessionId + "." + token + ".json"; }
      static string RecordText(string sessionId, string endpoint, long createdAt) { return "{\"version\":1,\"sessionId\":\"" + sessionId + "\",\"endpoint\":\"" + endpoint.Replace("\\", "\\\\") + "\",\"createdAt\":" + createdAt.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}"; }
      static OpenResult OpenRecord(IntPtr root, string name, bool create, byte[] descriptor, bool allowDeleteSharing) {
        IntPtr chars = IntPtr.Zero, unicode = IntPtr.Zero, security = IntPtr.Zero, handle = IntPtr.Zero;
        try {
          unicode = Unicode(name, out chars); var attributes = new OBJECT_ATTRIBUTES(); attributes.Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)); attributes.RootDirectory = root; attributes.ObjectName = unicode; attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
          if (create) { if (descriptor == null || descriptor.Length == 0) Fail("unavailable"); security = Marshal.AllocHGlobal(descriptor.Length); Marshal.Copy(descriptor, 0, security, descriptor.Length); attributes.SecurityDescriptor = security; }
          IO_STATUS_BLOCK statusBlock; uint status = NtCreateFile(out handle, SYNCHRONIZE | FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE, ref attributes, out statusBlock, IntPtr.Zero, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | (allowDeleteSharing ? FILE_SHARE_DELETE : 0), create ? FILE_CREATE : FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, IntPtr.Zero, 0);
          if (status != 0) { Close(handle); return new OpenResult(IntPtr.Zero, status); } return new OpenResult(handle, status);
        } finally { if (security != IntPtr.Zero) Marshal.FreeHGlobal(security); if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars); }
      }
      static RecordIdentity AssertRecord(IntPtr handle, string sid) {
        BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info) || info.NumberOfLinks != 1 || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) Fail("unsafe"); AssertOwned(handle, sid); return new RecordIdentity(info);
      }
      static RecordIdentity AssertRetainedPublication(SafeFileHandle handle, string sid) {
        if (handle == null || handle.IsInvalid || handle.IsClosed) Fail("unsafe");
        BY_HANDLE_FILE_INFORMATION info; IntPtr value = handle.DangerousGetHandle();
        if (!GetFileInformationByHandle(value, out info) || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) Fail("unsafe");
        AssertOwned(value, sid); return new RecordIdentity(info);
      }
      static string ReadRecordText(IntPtr handle) {
        BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info) || info.FileSizeHigh != 0 || info.FileSizeLow > 8192) Fail("invalid"); byte[] bytes = new byte[info.FileSizeLow]; uint read;
        if (!ReadFile(handle, bytes, info.FileSizeLow, out read, IntPtr.Zero) || read != info.FileSizeLow) Fail("invalid"); try { return new UTF8Encoding(false, true).GetString(bytes); } catch { Fail("invalid"); return null; }
      }
      static PresenceRecord ParseRecord(string name, string text) {
        int first = name.IndexOf('.'), second = first < 0 ? -1 : name.IndexOf('.', first + 1); if (first <= 0 || second <= first + 1 || second != name.Length - 5 || !name.EndsWith(".json", StringComparison.Ordinal)) Fail("invalid");
        string sessionId = name.Substring(0, first), token = name.Substring(first + 1, second - first - 1), endpoint = PipePrefix + token; string ignored; ValidateRecord(sessionId, endpoint, 0, out ignored);
        string prefix = "{\"version\":1,\"sessionId\":\"" + sessionId + "\",\"endpoint\":\"" + endpoint.Replace("\\", "\\\\") + "\",\"createdAt\":"; if (!text.StartsWith(prefix, StringComparison.Ordinal) || !text.EndsWith("}", StringComparison.Ordinal)) Fail("invalid");
        string number = text.Substring(prefix.Length, text.Length - prefix.Length - 1); if (number.Length == 0 || number.Length > 16) Fail("invalid"); long createdAt = 0; if (!Int64.TryParse(number, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out createdAt)) Fail("invalid"); ValidateRecord(sessionId, endpoint, createdAt, out ignored); return new PresenceRecord(sessionId, endpoint, token, createdAt);
      }
      static PresenceRecord ReadPinnedRecord(string name, string sid, out IntPtr handle, out RecordIdentity identity) {
        handle = IntPtr.Zero; identity = new RecordIdentity(); OpenResult opened = OpenRecord(Presence, name, false, null, true); if (opened.Handle == IntPtr.Zero) { SetNtStatus(opened.Status); Fail(opened.Status == STATUS_OBJECT_NAME_NOT_FOUND ? "not_found" : "unsafe"); }
        handle = opened.Handle; try { identity = AssertRecord(handle, sid); return ParseRecord(name, ReadRecordText(handle)); } catch { Close(handle); handle = IntPtr.Zero; throw; }
      }
      static uint RenameNoReplace(IntPtr file, IntPtr root, string name) {
        byte[] chars = Encoding.Unicode.GetBytes(name); int header = IntPtr.Size == 8 ? 20 : 12; IntPtr memory = Marshal.AllocHGlobal(header + chars.Length); try { for (int index = 0; index < header + chars.Length; index++) Marshal.WriteByte(memory, index, 0); Marshal.WriteIntPtr(memory, IntPtr.Size == 8 ? 8 : 4, root); Marshal.WriteInt32(memory, IntPtr.Size == 8 ? 16 : 8, chars.Length); Marshal.Copy(chars, 0, IntPtr.Add(memory, header), chars.Length); IO_STATUS_BLOCK io; return NtSetInformationFile(file, out io, memory, (uint)(header + chars.Length), 10); } finally { Marshal.FreeHGlobal(memory); }
      }
      static void DeletePinnedHandle(IntPtr file) { IntPtr memory = Marshal.AllocHGlobal(1); try { Marshal.WriteByte(memory, 1); IO_STATUS_BLOCK io; if (NtSetInformationFile(file, out io, memory, 1, FileDispositionInformation) != 0) Fail("unsafe"); } finally { Marshal.FreeHGlobal(memory); } }
      public static PresenceRecord NewRecord(string sessionId, long createdAt) { lock (Gate) { RequirePresence(); string token = Guid.NewGuid().ToString("N"), endpoint = PipePrefix + token, ignored; ValidateRecord(sessionId, endpoint, createdAt, out ignored); return new PresenceRecord(sessionId, endpoint, token, createdAt); } }
      static OwnedPublication PublishOwned(string sessionId, string endpoint, long createdAt, byte[] descriptor, string sid) {
        lock (Gate) {
          RequirePresence(); if (OwnedPublications.Count >= MaxOwnedPublications) Fail("busy");
          string token; ValidateRecord(sessionId, endpoint, createdAt, out token);
          string temporary = "." + Guid.NewGuid().ToString("N") + ".tmp", target = RecordName(sessionId, token);
          OpenResult opened = OpenRecord(Presence, temporary, true, descriptor, true);
          if (opened.Handle == IntPtr.Zero) { SetNtStatus(opened.Status); Fail(opened.Status == STATUS_OBJECT_NAME_COLLISION ? "busy" : "unsafe"); }
          IntPtr file = opened.Handle; bool transferred = false;
          try {
            RecordIdentity identity = AssertRecord(file, sid);
            byte[] bytes = new UTF8Encoding(false).GetBytes(RecordText(sessionId, endpoint, createdAt)); uint written;
            if (bytes.Length > 8192 || !WriteFile(file, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length || !FlushFileBuffers(file)) Fail("unavailable");
            uint status = RenameNoReplace(file, Presence, target);
            if (status != 0) { uint win32 = RtlNtStatusToDosError(status); Fail(win32 == 80 || win32 == 183 ? "busy" : "unsafe"); }
            OwnedPublication owned = new OwnedPublication(new PresenceRecord(sessionId, endpoint, token, createdAt), identity, sid, file);
            try { OwnedPublications.Add(owned); transferred = true; return owned; } catch { try { DeletePinnedHandle(file); } finally { owned.Dispose(); transferred = true; } throw; }
          } finally {
            if (!transferred) { try { DeletePinnedHandle(file); } catch {} Close(file); }
          }
        }
      }
      public static void Publish(string sessionId, string endpoint, long createdAt, byte[] descriptor, string sid) { PublishOwned(sessionId, endpoint, createdAt, descriptor, sid); }
          public static PresenceRecord[] List(string sid) { return List(null, sid); }
      public static PresenceRecord[] List(string excluded, string sid) { lock (Gate) { RequirePresence(); if (excluded != null && !Regex.IsMatch(excluded, "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")) Fail("invalid"); var newest = new Dictionary<string, PresenceRecord>(StringComparer.Ordinal); foreach (string name in EnumeratePinned(Presence)) { IntPtr file = IntPtr.Zero; try { RecordIdentity ignoredIdentity; PresenceRecord record = ReadPinnedRecord(name, sid, out file, out ignoredIdentity); if (record.SessionId == excluded) continue; PresenceRecord prior; if (!newest.TryGetValue(record.SessionId, out prior) || record.CreatedAt > prior.CreatedAt || (record.CreatedAt == prior.CreatedAt && String.CompareOrdinal(record.Token, prior.Token) > 0)) newest[record.SessionId] = record; } catch (BootstrapFailure) { } finally { Close(file); } } var records = new List<PresenceRecord>(newest.Values); records.Sort(delegate(PresenceRecord left, PresenceRecord right) { return String.CompareOrdinal(left.SessionId, right.SessionId); }); return records.ToArray(); } }
      public static PresenceRecord Resolve(string sessionId, string sid) { PresenceRecord[] records = List(null, sid); foreach (PresenceRecord record in records) if (record.SessionId == sessionId) return record; Fail("not_found"); return null; }
      static void RemoveOwnedPublication(OwnedPublication owned) {
        IntPtr current = IntPtr.Zero;
        try {
          RecordIdentity retained = AssertRetainedPublication(owned.Handle, owned.Sid);
          if (!retained.Equals(owned.Identity)) Fail("unsafe");
          RecordIdentity currentIdentity; PresenceRecord record = ReadPinnedRecord(RecordName(owned.Record.SessionId, owned.Record.Token), owned.Sid, out current, out currentIdentity);
          if (!SameRecord(record, owned.Record.SessionId, owned.Record.Endpoint, owned.Record.CreatedAt) || !currentIdentity.Equals(retained)) Fail("unsafe");
          DeletePinnedHandle(current);
        } catch (BootstrapFailure failure) { if (failure.Code != "not_found") throw; }
        finally { Close(current); OwnedPublications.Remove(owned); owned.Dispose(); }
      }
      static void RemoveListenerPublication(OwnedListener listener) {
            if (listener == null) return;
            OwnedPublication owned = listener.Publication; listener.Publication = null;
            // Reference membership, rather than the public tuple, prevents this listener
            // from deleting a later publication that reused the same visible record.
            if (owned == null || !OwnedPublications.Contains(owned)) return;
            RemoveOwnedPublication(owned);
          }
          public static void RemoveOwn(string sessionId, string endpoint, long createdAt, string sid) {
        lock (Gate) {
          RequirePresence(); string token; ValidateRecord(sessionId, endpoint, createdAt, out token);
          OwnedPublication owned = FindOwned(sessionId, endpoint, createdAt); if (owned == null) return;
          IntPtr file = IntPtr.Zero;
          try {
            if (owned.Sid != sid) Fail("unsafe"); RecordIdentity retained = AssertRetainedPublication(owned.Handle, owned.Sid); if (!retained.Equals(owned.Identity)) Fail("unsafe"); RecordIdentity identity; PresenceRecord record = ReadPinnedRecord(RecordName(sessionId, token), sid, out file, out identity);
            if (!SameRecord(record, sessionId, endpoint, createdAt) || !identity.Equals(retained)) Fail("unsafe");
            DeletePinnedHandle(file);
          } catch (BootstrapFailure failure) { if (failure.Code != "not_found") throw; }
          finally { Close(file); OwnedPublications.Remove(owned); owned.Dispose(); }
        }
      }
      // CreateNamedPipeW's documented FILE_FLAG_FIRST_PIPE_INSTANCE guard avoids
      // relying on PipeOptions.FirstPipeInstance, which PS5.1 may not expose.
      const uint PIPE_ACCESS_DUPLEX = 3, PIPE_TYPE_BYTE = 0, PIPE_WAIT = 0, FILE_FLAG_OVERLAPPED = 0x40000000, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
      const int MaxPipeInstances = 4, MaxPipeBytes = 65536, PipeDeadlineMilliseconds = 2000;
      sealed class PipeClient {
        public readonly OwnedListener Listener; public readonly NamedPipeServerStream Pipe; public readonly string ConnectionId;
        public readonly MemoryStream Bytes = new MemoryStream(); public readonly byte[] Buffer = new byte[4096]; public Timer Timer; public string Id; public bool Closed, Writing, Accepting;
        public PipeClient(OwnedListener listener, NamedPipeServerStream pipe) { Listener = listener; Pipe = pipe; ConnectionId = Guid.NewGuid().ToString("N"); }
      }
      sealed class OwnedListener {
        public readonly PresenceRecord Record; public readonly string Sid; public readonly byte[] Descriptor; public readonly int Generation;
        public readonly List<PipeClient> Clients = new List<PipeClient>(); public OwnedPublication Publication; public bool FirstCreated; public bool Stopped;
        public OwnedListener(PresenceRecord record, string sid, byte[] descriptor, int generation) { Record = record; Sid = sid; Descriptor = descriptor; Generation = generation; }
      }
      static int ListenerGeneration = 0;
      static void AssertPipeOwned(NamedPipeServerStream pipe, string sid) {
        PipeSecurity security = pipe.GetAccessControl();
        SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner == null || owner.Value != sid || !security.AreAccessRulesProtected) Fail("unsafe");
        AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)); if (rules.Count != 1) Fail("unsafe");
        PipeAccessRule rule = rules[0] as PipeAccessRule;
        if (rule == null || rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.IdentityReference == null || rule.IdentityReference.Value != sid || rule.PipeAccessRights != PipeAccessRights.FullControl) Fail("unsafe");
      }
      static NamedPipeServerStream CreateOwnedPipe(OwnedListener listener, bool first) {
        IntPtr descriptor = IntPtr.Zero, attributes = IntPtr.Zero, handle = IntPtr.Zero;
        try {
          descriptor = Marshal.AllocHGlobal(listener.Descriptor.Length); Marshal.Copy(listener.Descriptor, 0, descriptor, listener.Descriptor.Length);
          int size = IntPtr.Size == 8 ? 24 : 12; attributes = Marshal.AllocHGlobal(size); for (int index = 0; index < size; index++) Marshal.WriteByte(attributes, index, 0);
          Marshal.WriteInt32(attributes, 0, size); Marshal.WriteIntPtr(attributes, IntPtr.Size == 8 ? 8 : 4, descriptor);
          handle = CreateNamedPipe(PipePrefix + listener.Record.Token, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_WAIT, MaxPipeInstances, MaxPipeBytes, MaxPipeBytes, PipeDeadlineMilliseconds, attributes);
          if (handle == IntPtr.Zero || handle.ToInt64() == -1) { Close(handle); Fail("unavailable"); }
          NamedPipeServerStream pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(handle, true)); handle = IntPtr.Zero;
          try { AssertPipeOwned(pipe, listener.Sid); return pipe; } catch { pipe.Dispose(); throw; }
        } finally { Close(handle); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor); }
      }
      // Native failure notification has a fixed schema and is queued only after Gate-owned
      // cleanup, so stdout backpressure cannot delay timer or handle release transitions.
      static void ReportListenerFailure(int generation) {
        ThreadPool.QueueUserWorkItem(delegate(object ignored) {
          try { WriteControl("{\"event\":\"listener-failed\",\"generation\":" + generation.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"error\":\"unavailable\"}"); } catch {}
        });
      }
      static void FailListener(OwnedListener listener) {
            if (listener == null || listener.Stopped) return;
            listener.Stopped = true;
            // Remove the identity-checked publication while an owned pipe still holds
            // the endpoint. An unsafe publication is left untouched rather than deleted.
            try { RemoveListenerPublication(listener); } catch {}
            foreach (PipeClient client in listener.Clients.ToArray()) ClosePipe(client);
            if (Listener == listener) Listener = null;
            ReportListenerFailure(listener.Generation);
          }
          static void ClosePipe(PipeClient client) {
        if (client == null || client.Closed) return;
            OwnedListener listener = client.Listener;
            bool active = Listener == listener && !listener.Stopped;
            // Clients owns every server instance, including pending accepts. Before
            // disposing the final instance, establish its replacement while this
            // owned handle still prevents a third party from claiming the endpoint.
            if (active && listener.Clients.Count == 1 && !ArmAccept(listener, client)) { FailListener(listener); return; }
            client.Closed = true;
        try { if (client.Timer != null) client.Timer.Dispose(); } catch {} try { client.Pipe.Dispose(); } catch {} client.Listener.Clients.Remove(client);
        if (active && !ArmAccept(listener, null)) FailListener(listener);
      }
      static void SendEvent(PipeClient client) {
        string wire = Convert.ToBase64String(client.Bytes.ToArray());
        lock (OutputGate) { Console.Out.WriteLine("{\"event\":\"notification\",\"connectionId\":\"" + client.ConnectionId + "\",\"generation\":" + client.Listener.Generation.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"wire\":\"" + wire + "\"}"); }
      }
      static void FinishAck(IAsyncResult result) {
        PipeClient client = (PipeClient)result.AsyncState;
        try { client.Pipe.EndWrite(result); } catch {}
        lock (Gate) { ClosePipe(client); }
      }
      // Gate owns state transitions; BeginWrite runs only after the transition unlocks.
      static bool PrepareAckLocked(PipeClient client, out string id) {
        id = null;
        if (client == null || client.Closed || client.Writing || Listener != client.Listener || client.Listener.Stopped || String.IsNullOrEmpty(client.Id)) return false;
        client.Writing = true;
        try { client.Timer.Change(PipeDeadlineMilliseconds, Timeout.Infinite); }
        catch { ClosePipe(client); return false; }
        id = client.Id; return true;
      }
      static void BeginAck(PipeClient client, string id, bool accepted, string error) {
        string value = accepted ? "{\"version\":1,\"kind\":\"ack\",\"id\":\"" + id + "\",\"accepted\":true}\n" : "{\"version\":1,\"kind\":\"ack\",\"id\":\"" + id + "\",\"accepted\":false,\"error\":\"" + error + "\"}\n";
        try { byte[] bytes = new UTF8Encoding(false).GetBytes(value); client.Pipe.BeginWrite(bytes, 0, bytes.Length, FinishAck, client); }
        catch { lock (Gate) { ClosePipe(client); } }
      }
      static void OnPipeTimeout(object state) {
        PipeClient timed = (PipeClient)state; string id;
        lock (Gate) {
          if (timed.Closed || Listener != timed.Listener || timed.Listener.Stopped) return;
          // The initial deadline closes an incomplete request; the rearmed deadline
          // closes an ACK that has not completed, rather than silently returning.
          if (String.IsNullOrEmpty(timed.Id) || timed.Writing) { ClosePipe(timed); return; }
          if (!PrepareAckLocked(timed, out id)) return;
        }
        BeginAck(timed, id, false, "timeout");
      }
      static void ReadPipe(IAsyncResult result) {
        PipeClient client = (PipeClient)result.AsyncState;
        try { int count = client.Pipe.EndRead(result); lock (Gate) {
          if (client.Closed || Listener != client.Listener || client.Listener.Stopped) return;
          if (count <= 0 || client.Bytes.Length + count > MaxPipeBytes) { ClosePipe(client); return; }
          client.Bytes.Write(client.Buffer, 0, count); byte[] bytes = client.Bytes.GetBuffer(); int length = (int)client.Bytes.Length, newline = Array.IndexOf(bytes, (byte)10, 0, length);
          if (newline < 0) { client.Pipe.BeginRead(client.Buffer, 0, client.Buffer.Length, ReadPipe, client); return; }
          if (newline != length - 1) { ClosePipe(client); return; }
          string text; try { text = new UTF8Encoding(false, true).GetString(bytes, 0, newline); } catch { ClosePipe(client); return; }
          Match match = Regex.Match(text, "^\\{\\s*\"version\"\\s*:\\s*1\\s*,\\s*\"kind\"\\s*:\\s*\"notification\"\\s*,\\s*\"id\"\\s*:\\s*\"([A-Za-z0-9][A-Za-z0-9_-]{0,127})\"");
          if (!match.Success) { ClosePipe(client); return; } client.Id = match.Groups[1].Value; SendEvent(client);
        }} catch { lock (Gate) { ClosePipe(client); } }
      }
      static bool ArmAccept(OwnedListener listener, PipeClient retiring = null) {
        if (listener.Stopped || Listener != listener) return false;
            foreach (PipeClient candidate in listener.Clients) if (candidate != retiring && !candidate.Closed && candidate.Accepting) return true;
            if (listener.Clients.Count >= MaxPipeInstances) return true;
        NamedPipeServerStream pipe = null; PipeClient client = null;
        try { pipe = CreateOwnedPipe(listener, !listener.FirstCreated); listener.FirstCreated = true; client = new PipeClient(listener, pipe); client.Accepting = true; pipe = null; listener.Clients.Add(client); client.Pipe.BeginWaitForConnection(AcceptPipe, client); return true; }
        catch {
              if (pipe != null) pipe.Dispose();
              if (client != null) { client.Closed = true; try { client.Pipe.Dispose(); } catch {} listener.Clients.Remove(client); }
              return false;
            }
      }
      static void AcceptPipe(IAsyncResult result) {
        PipeClient client = (PipeClient)result.AsyncState;
        try { client.Pipe.EndWaitForConnection(result); lock (Gate) {
          if (client.Closed || Listener != client.Listener || client.Listener.Stopped) { ClosePipe(client); return; }
          client.Accepting = false;
           if (!ArmAccept(client.Listener)) { FailListener(client.Listener); return; }
          client.Timer = new Timer(OnPipeTimeout, client, PipeDeadlineMilliseconds, Timeout.Infinite);
          client.Pipe.BeginRead(client.Buffer, 0, client.Buffer.Length, ReadPipe, client);
        }} catch { lock (Gate) { ClosePipe(client); } }
      }
      public static PresenceRecord Listen(string sessionId, long createdAt, int? requestedGeneration, byte[] pipeDescriptor, byte[] presenceDescriptor, string sid) {
        lock (Gate) {
          RequirePresence(); if (Listener != null) Fail("busy");
          // Legacy four-field requests allocate helper epochs. New requests reserve
          // a host epoch above the helper high-water mark; skipped local attempts
          // therefore never force a reused or contiguous value after a late failure.
          int generation;
          if (requestedGeneration.HasValue) {
            generation = requestedGeneration.Value;
            if (generation < 1 || generation <= ListenerGeneration) Fail("invalid");
          } else {
            if (ListenerGeneration == Int32.MaxValue) Fail("invalid");
            generation = ListenerGeneration + 1;
          }
          PresenceRecord record = NewRecord(sessionId, createdAt);
          ListenerGeneration = generation;
          OwnedListener listener = new OwnedListener(record, sid, pipeDescriptor, generation); Listener = listener;
          try {
            if (!ArmAccept(listener) || listener.Clients.Count == 0) Fail("unavailable");
            // The returned record is published while Gate still protects readiness,
            // so a later native failure removes this exact owned publication.
            listener.Publication = PublishOwned(record.SessionId, record.Endpoint, record.CreatedAt, presenceDescriptor, sid);
            return record;
          } catch { FailListener(listener); throw; }
        }
      }
      public static void Acknowledge(string connectionId, int generation, string id, bool accepted) {
        PipeClient selected = null; string ackId;
            lock (Gate) {
              if (Listener == null || Listener.Stopped || Listener.Generation != generation) return;
              foreach (PipeClient client in Listener.Clients) if (!client.Closed && client.ConnectionId == connectionId && client.Id == id) { selected = client; break; }
              if (selected == null || !PrepareAckLocked(selected, out ackId)) return;
            }
            BeginAck(selected, ackId, accepted, accepted ? null : "rejected");
      }
      public static void StopListener(string sessionId, string endpoint, long createdAt, string sid) {
        lock (Gate) { if (Listener == null) return; string token; ValidateRecord(sessionId, endpoint, createdAt, out token); if (!SameRecord(Listener.Record, sessionId, endpoint, createdAt) || Listener.Sid != sid) Fail("unsafe"); OwnedListener listener = Listener; listener.Stopped = true; try { RemoveListenerPublication(listener); } finally { foreach (PipeClient client in listener.Clients.ToArray()) ClosePipe(client); Listener = null; } }
      }
      public static void Initialize(string agentHome, byte[] descriptor, string sid) {
    lock (Gate) {
      InitializationStage = "unknown"; InitializationNtStatus = null;
      CloseAll();
      try {
        string[] components = Components(agentHome);
        uint volumeSerial;
        SetStage("volume-open"); IntPtr volume = RequireVolumeOpen(VolumePath(agentHome, out volumeSerial), volumeSerial); Handles.Add(volume); IntPtr parent = volume;
        foreach (string component in components) { SetStage("ancestor-open"); IntPtr child = RequireOpen(parent, component, false); Handles.Add(child); parent = child; }
        // gentle-agents is a shared routing parent created by the host lifecycle; never repair or create it here.
        SetStage("routing-open"); IntPtr routing = RequireOpen(parent, "gentle-agents", false); Handles.Add(routing);
        IntPtr transport = CreateOrOpenOwned(routing, "transport", descriptor, sid, "transport-create-or-open", "transport-assert-owned"); Handles.Add(transport);
        Presence = CreateOrOpenOwned(transport, "presence", descriptor, sid, "presence-create-or-open", "presence-assert-owned"); Handles.Add(Presence);
      } catch { CloseAll(); throw; } finally { InitializationStage = "unknown"; InitializationNtStatus = null; }
    }
  }
  public static void CloseAll() {
        lock (Gate) {
          // Stop accepts and clients before removing owned presence and ancestor handles.
          if (Listener != null) { try { StopListener(Listener.Record.SessionId, Listener.Record.Endpoint, Listener.Record.CreatedAt, Listener.Sid); } catch { Listener = null; } }
          // Cleanup is best effort but always releases every retained publication handle before ancestors close.
          for (int index = OwnedPublications.Count - 1; index >= 0; index--) { OwnedPublication owned = OwnedPublications[index]; try { RemoveOwnedPublication(owned); } catch { if (OwnedPublications.Contains(owned)) OwnedPublications.Remove(owned); owned.Dispose(); } }
          for (int index = Handles.Count - 1; index >= 0; index--) Close(Handles[index]);
          Handles.Clear(); OwnedPublications.Clear(); Presence = IntPtr.Zero;
        }
      }
}
'@
	$nativeReady = $true
} catch {
	$nativeReady = $false
	Write-BootstrapDiagnostic (@($addTypeErrors) + @($_))
}
if ($nativeReady) {
	[WindowsSessionBootstrap]::WriteControl('{"event":"startup-marker","marker":"native-ready"}')
}

function Write-BootstrapRejectionDiagnostic([BootstrapFailure]$failure) {
	if ($failure.Code -ne 'unsafe') { return }
	$stage = 'unknown'
	$ntstatus = $null
	try {
		$candidateStage = Get-BootstrapProperty $failure 'Stage'
		if ($candidateStage -is [string] -and $candidateStage -in @('volume-open', 'ancestor-open', 'routing-open', 'transport-create-or-open', 'transport-assert-owned', 'presence-create-or-open', 'presence-assert-owned')) { $stage = $candidateStage }
		$candidateStatus = Get-BootstrapProperty $failure 'NtStatus'
		if ($candidateStatus -is [uint32]) { $ntstatus = [uint64]$candidateStatus }
	} catch {}
	[Console]::Error.WriteLine(([pscustomobject]@{ kind = 'windows-session-bootstrap-rejection'; stage = $stage; ntstatus = $ntstatus } | ConvertTo-Json -Compress))
}

function Write-Reply([string]$requestId, [bool]$ok, $result, [string]$error) {
	$line = if ($ok) { @{ requestId = $requestId; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 4 } else { @{ requestId = $requestId; ok = $false; error = $error } | ConvertTo-Json -Compress }
	if ($nativeReady) { [WindowsSessionBootstrap]::WriteControl($line) } else { [Console]::Out.WriteLine($line) }
}
function Get-CurrentPrivateDescriptor {
	$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
	$security = [Security.AccessControl.DirectorySecurity]::new(); $security.SetAccessRuleProtection($true, $false); $security.SetOwner($sid)
	$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
	return [pscustomobject]@{ Sid = $sid.Value; Descriptor = $security.GetSecurityDescriptorBinaryForm() }
}
function Get-CurrentPipeDescriptor {
	$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
	$security = [IO.Pipes.PipeSecurity]::new(); $security.SetAccessRuleProtection($true, $false); $security.SetOwner($sid)
	$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
	return [pscustomobject]@{ Sid = $sid.Value; Descriptor = $security.GetSecurityDescriptorBinaryForm() }
}
function ConvertTo-PublicPresenceRecord($record) {
	return [pscustomobject]@{ version = 1; sessionId = $record.SessionId; endpoint = $record.Endpoint; createdAt = $record.CreatedAt }
}
function Try-PresenceCreatedAt([object]$value, [ref]$createdAt) {
	$candidate = [int64]0
	if ($value -is [sbyte] -or $value -is [byte] -or $value -is [int16] -or $value -is [uint16] -or $value -is [int32] -or $value -is [uint32] -or $value -is [int64]) { $candidate = [int64]$value }
	elseif ($value -is [uint64]) { if ($value -gt [uint64]9007199254740991) { return $false }; $candidate = [int64]$value }
	else { return $false }
	if ($candidate -lt 0 -or $candidate -gt 9007199254740991) { return $false }
	$createdAt.Value = $candidate
	return $true
}
function Is-PresenceRecord($record, [ref]$createdAt) {
	if ($null -eq $record -or $record -isnot [psobject]) { return $false }
	$names = @($record.PSObject.Properties | ForEach-Object { $_.Name })
	if ($names.Count -ne 4 -or @($names | Where-Object { $_ -notin @('version', 'sessionId', 'endpoint', 'createdAt') }).Count -ne 0) { return $false }
	return $record.version -eq 1 -and $record.sessionId -is [string] -and $record.endpoint -is [string] -and (Try-PresenceCreatedAt $record.createdAt $createdAt)
}
function Is-RequestId([object]$value) { return $value -is [string] -and $value -match '^[A-Za-z0-9-]{1,128}$' }
function Is-ExactRequest($request, [string[]]$names) {
	$actual = @($request.PSObject.Properties | ForEach-Object { $_.Name })
	return $actual.Count -eq $names.Count -and @($actual | Where-Object { $_ -notin $names }).Count -eq 0
}
function Read-ControlLine {
	$buffer = [Text.StringBuilder]::new()
	$bytes = 0
	$overflow = $false
	$next = -1
	while (($next = [Console]::In.Read()) -ne -1) {
		if ($next -eq 10) { break }
		if ($next -eq 13) { continue }
		$char = [char]$next
		$bytes += [Text.Encoding]::UTF8.GetByteCount([string]$char)
		if ($bytes -gt $maxControlBytes) { $overflow = $true; continue }
		[void]$buffer.Append($char)
	}
	if ($next -eq -1 -and $buffer.Length -eq 0 -and -not $overflow) { return $null }
	if ($overflow) { return '' }
	return $buffer.ToString()
}

try {
	:requests while (($line = Read-ControlLine) -ne $null) {
		if ([Text.Encoding]::UTF8.GetByteCount($line) -gt $maxControlBytes) { break }
		$request = $null
		try { $request = $line | ConvertFrom-Json -ErrorAction Stop } catch { break }
		if ($null -eq $request -or -not (Is-RequestId $request.requestId) -or $request.operation -isnot [string]) { break }
		$id = $request.requestId
		switch ($request.operation) {
			'start' {
				if (-not (Is-ExactRequest $request @('requestId', 'operation'))) { Write-Reply $id $false $null 'invalid'; break requests }
				if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }
				Write-Reply $id $true @{ state = 'partial' } $null; break
			}
			'initialize' {
				if (-not (Is-ExactRequest $request @('requestId', 'operation', 'agentHome')) -or $request.agentHome -isnot [string]) { Write-Reply $id $false $null 'invalid'; break requests }
				if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }
				try {
					$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
					$security = [Security.AccessControl.DirectorySecurity]::new(); $security.SetAccessRuleProtection($true, $false); $security.SetOwner($sid)
					$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
					[WindowsSessionBootstrap]::Initialize($request.agentHome, $security.GetSecurityDescriptorBinaryForm(), $sid.Value)
					Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete' } $null
				} catch [BootstrapFailure] { Write-BootstrapRejectionDiagnostic $_.Exception; Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }
				break
			}
			'enumerate' { if (-not (Is-ExactRequest $request @('requestId', 'operation'))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete'; entries = [WindowsSessionBootstrap]::EnumeratePresence() } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'record' { $createdAt = [int64]0; if (-not (Is-ExactRequest $request @('requestId', 'operation', 'sessionId', 'createdAt')) -or $request.sessionId -isnot [string] -or -not (Try-PresenceCreatedAt $request.createdAt ([ref]$createdAt))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { Write-Reply $id $true (ConvertTo-PublicPresenceRecord ([WindowsSessionBootstrap]::NewRecord($request.sessionId, $createdAt))) $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'publish' { $createdAt = [int64]0; if (-not (Is-ExactRequest $request @('requestId', 'operation', 'record')) -or -not (Is-PresenceRecord $request.record ([ref]$createdAt))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $identity = Get-CurrentPrivateDescriptor; [WindowsSessionBootstrap]::Publish($request.record.sessionId, $request.record.endpoint, $createdAt, $identity.Descriptor, $identity.Sid); Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete' } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'list' { $hasExcludeSessionId = Is-ExactRequest $request @('requestId', 'operation', 'excludeSessionId'); if ($hasExcludeSessionId) { $excludeSessionId = $request.excludeSessionId; if ($excludeSessionId -isnot [string]) { Write-Reply $id $false $null 'invalid'; break requests } } elseif (-not (Is-ExactRequest $request @('requestId', 'operation'))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $identity = Get-CurrentPrivateDescriptor; $nativeRecords = if ($hasExcludeSessionId) { [WindowsSessionBootstrap]::List($excludeSessionId, $identity.Sid) } else { [WindowsSessionBootstrap]::List($identity.Sid) }; $records = @($nativeRecords | ForEach-Object { ConvertTo-PublicPresenceRecord $_ }); Write-Reply $id $true @{ records = $records } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'resolve' { if (-not (Is-ExactRequest $request @('requestId', 'operation', 'sessionId')) -or $request.sessionId -isnot [string]) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $identity = Get-CurrentPrivateDescriptor; Write-Reply $id $true (ConvertTo-PublicPresenceRecord ([WindowsSessionBootstrap]::Resolve($request.sessionId, $identity.Sid))) $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'remove' { $createdAt = [int64]0; if (-not (Is-ExactRequest $request @('requestId', 'operation', 'record')) -or -not (Is-PresenceRecord $request.record ([ref]$createdAt))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $identity = Get-CurrentPrivateDescriptor; [WindowsSessionBootstrap]::RemoveOwn($request.record.sessionId, $request.record.endpoint, $createdAt, $identity.Sid); Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete' } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'listen' { $createdAt = [int64]0; $hasGeneration = Is-ExactRequest $request @('requestId', 'operation', 'sessionId', 'createdAt', 'generation'); $legacy = Is-ExactRequest $request @('requestId', 'operation', 'sessionId', 'createdAt'); if ((-not $hasGeneration -and -not $legacy) -or $request.sessionId -isnot [string] -or -not (Try-PresenceCreatedAt $request.createdAt ([ref]$createdAt))) { Write-Reply $id $false $null 'invalid'; break requests }; $requestedGeneration = $null; if ($hasGeneration) { $generation = [int64]0; if (-not (Try-PresenceCreatedAt $request.generation ([ref]$generation)) -or $generation -lt 1 -or $generation -gt 2147483647) { Write-Reply $id $false $null 'invalid'; break requests }; $requestedGeneration = [Nullable[int]]([int]$generation) }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $pipeIdentity = Get-CurrentPipeDescriptor; $presenceIdentity = Get-CurrentPrivateDescriptor; if ($pipeIdentity.Sid -ne $presenceIdentity.Sid) { throw [System.InvalidOperationException]::new() }; Write-Reply $id $true (ConvertTo-PublicPresenceRecord ([WindowsSessionBootstrap]::Listen($request.sessionId, $createdAt, $requestedGeneration, $pipeIdentity.Descriptor, $presenceIdentity.Descriptor, $pipeIdentity.Sid))) $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'ack' { $generation = [int64]0; if (-not (Is-ExactRequest $request @('requestId', 'operation', 'connectionId', 'generation', 'id', 'accepted')) -or -not (Is-RequestId $request.connectionId) -or -not (Is-RequestId $request.id) -or -not (Try-PresenceCreatedAt $request.generation ([ref]$generation)) -or $generation -lt 1 -or $generation -gt 2147483647 -or $request.accepted -isnot [bool]) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { [WindowsSessionBootstrap]::Acknowledge($request.connectionId, [int]$generation, $request.id, $request.accepted); Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete' } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'stop-listener' { $createdAt = [int64]0; if (-not (Is-ExactRequest $request @('requestId', 'operation', 'record')) -or -not (Is-PresenceRecord $request.record ([ref]$createdAt))) { Write-Reply $id $false $null 'invalid'; break requests }; if (-not $nativeReady) { Write-Reply $id $false $null 'unavailable'; break }; try { $identity = Get-CurrentPrivateDescriptor; [WindowsSessionBootstrap]::StopListener($request.record.sessionId, $request.record.endpoint, $createdAt, $identity.Sid); Write-Reply $id $true @{ state = 'initialized'; bootstrap = 'complete' } $null } catch [BootstrapFailure] { Write-Reply $id $false $null $_.Exception.Code } catch { Write-Reply $id $false $null 'unavailable' }; break }
			'shutdown' { if (-not (Is-ExactRequest $request @('requestId', 'operation'))) { Write-Reply $id $false $null 'invalid'; break requests }; if ($nativeReady) { [WindowsSessionBootstrap]::CloseAll() }; Write-Reply $id $true @{ state = 'partial' } $null; break }
			default { Write-Reply $id $false $null 'invalid'; break }
		}
	}
} finally { if ($nativeReady) { [WindowsSessionBootstrap]::CloseAll() } }
