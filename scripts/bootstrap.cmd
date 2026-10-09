@echo off
setlocal DisableDelayedExpansion
rem Trusted extracted/checkout bundle only. Never pipe a remote script here.
rem Fixed stock PowerShell commands; paths are environment DATA, not PS source.
rem Each invocation is below CMD's logical command length limit.
set "GENTLE_BOOTSTRAP_BUNDLE=%~dp0.."
set "GENTLE_BOOTSTRAP_TOOLS=%LOCALAPPDATA%\.gentle-shell-bootstrap-tools.%RANDOM%.%RANDOM%.%RANDOM%"
set "GENTLE_BOOTSTRAP_OWNED="
set "GENTLE_BOOTSTRAP_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%GENTLE_BOOTSTRAP_PS%" goto unavailable

rem Bundle/dependency checks precede ALL acquisition and per-user writes.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$bundle = [IO.Path]::GetFullPath($env:GENTLE_BOOTSTRAP_BUNDLE);" ^
  "foreach ($file in @('bin/gentle-shell-install.mjs','package.json','scripts/installer-downloads.mjs','scripts/installer-windows.mjs','scripts/installer-windows-artifacts.json')) {" ^
  "  $item = Get-Item -LiteralPath (Join-Path $bundle $file) -Force;" ^
  "  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe bundle file' };" ^
  "};" ^
  "$metadata = Get-Content -LiteralPath (Join-Path $bundle 'package.json') -Raw | ConvertFrom-Json;" ^
  "if ($metadata.engines.node -notmatch '^>=[0-9]+\.[0-9]+\.[0-9]+$' -or $metadata.packageManager -ne 'pnpm@11.1.1') { throw 'Repository prerequisite unknown' };" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: future wizard/dependent bundle file missing, unsupported metadata, or managed policy denial. No acquisition attempted.'); exit 1 } }"
if errorlevel 1 goto failed

rem Claim an absent unique directory beneath a verified local per-user parent.
rem No security changes outside this new prerequisite directory.
rem Strict target/parent rights: ReadAndExecute + Synchronize (0x1200a9).
rem Distant existing ancestors additionally permit sibling CreateDirectories (4).
rem WriteData/reparse-affecting writes, deletion and ACL/owner changes still fail.
rem Failures append one fixed reason code (the failed check), never path/SID/error text;
rem other exceptions report unexpected-<step>. ACLs use .NET, not Security-module
rem cmdlets: PowerShell 7's inherited PSModulePath breaks their 5.1 autoload.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { $claimed = $false; $step = 'policy'; try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'policy' };" ^
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User;" ^
  "$trusted = @($me.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" ^
  "$step = 'path-mismatch'; $tools = [IO.Path]::GetFullPath($env:GENTLE_BOOTSTRAP_TOOLS); $path = [IO.Directory]::GetParent($tools).FullName;" ^
  "if (-not [IO.Path]::IsPathRooted($env:LOCALAPPDATA) -or $tools.StartsWith('\\') -or $path -ne [IO.Path]::GetFullPath($env:LOCALAPPDATA)) { throw 'path-mismatch' };" ^
  "$depth = 1;" ^
  "$step = 'home-owner'; $homeAcl = [IO.Directory]::GetAccessControl($path); if ($homeAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'home-owner' };" ^
  "$step = 'ancestor-walk'; while ($path) {" ^
  "  $item = Get-Item -LiteralPath $path -Force; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ancestor-reparse' };" ^
  "  $acl = [IO.Directory]::GetAccessControl($path); if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'ancestor-owner' };" ^
  "  $allowedRights = 0x1200a9; if ($depth -ge 2) { $allowedRights = 0x1200ad };" ^
  "  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {" ^
  "    if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([long]$rule.FileSystemRights -band (-bnot [long]$allowedRights)) -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'acl-mask' };" ^
  "  }; $parent = [IO.Directory]::GetParent($path); if ($null -eq $parent) { break }; $path = $parent.FullName; $depth++;" ^
  "};" ^
  "$step = 'create'; if (Test-Path -LiteralPath $tools) { throw 'collision' }; $null = New-Item -ItemType Directory -Path $tools; $claimed = $true;" ^
  "$step = 'private-acl'; $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false);" ^
  "foreach ($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) {" ^
  "  $identity = New-Object Security.Principal.SecurityIdentifier($sid);" ^
  "  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule);" ^
  "}; [IO.Directory]::SetAccessControl($tools,$acl);" ^
  "$verified = [IO.Directory]::GetAccessControl($tools); if (-not $verified.AreAccessRulesProtected) { throw 'protected-dacl' };" ^
  "if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'private-owner' };" ^
  "foreach ($rule in $verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -ne 'Allow' -or @($me.Value,'S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { throw 'private-ace' } };" ^
  "$step = 'marker'; $null = New-Item -ItemType File -Path (Join-Path $tools '.bootstrap-owned') -Value 'gentle-pi prerequisite tooling only';" ^
  "} catch { $reason = 'unexpected-' + $step; if ($_.Exception.Message -cmatch '^(policy|path-mismatch|home-owner|ancestor-reparse|ancestor-owner|acl-mask|collision|protected-dacl|private-owner|private-ace)$') { $reason = $_.Exception.Message };" ^
  "if ($claimed) { Remove-Item -LiteralPath $env:GENTLE_BOOTSTRAP_TOOLS -Recurse -Force -ErrorAction SilentlyContinue }; [Console]::Error.WriteLine('Bootstrap: private storage ACL/reparse/ownership claim failed or policy denied it. Reason: ' + $reason); exit 1 } }"
if errorlevel 1 goto failed
set "GENTLE_BOOTSTRAP_OWNED=1"

rem Select an existing native Node without invoking any command interpreter shim.
rem Absence alone authorizes pinned acquisition; incompatibility never replaces.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$command = $null; try { $command = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 } catch [Management.Automation.CommandNotFoundException] { $command = $null };" ^
  "if ($null -ne $command) { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($command.Source); $record = [IO.File]::Open((Join-Path $env:GENTLE_BOOTSTRAP_TOOLS '.node-target'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try { $record.Write($bytes,0,$bytes.Length) } finally { $record.Dispose() } };" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: existing Node resolution failed or policy denied it.'); exit 1 } }"
if errorlevel 1 goto failed

rem Fixed official ZIP transport: no redirects, bounded bytes/time, no TLS changes.
rem Integrity is verified before ZIP processing or executable publication.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; if (Test-Path -LiteralPath (Join-Path $tools '.node-target')) { exit 0 };" ^
  "$architecture = $env:PROCESSOR_ARCHITECTURE; if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 };" ^
  "switch ($architecture) { 'AMD64' { $arch = 'x64' } 'ARM64' { $arch = 'arm64' } default { throw 'Unsupported architecture' } };" ^
  "$pins = Get-Content -LiteralPath (Join-Path $env:GENTLE_BOOTSTRAP_BUNDLE 'scripts/installer-windows-artifacts.json') -Raw | ConvertFrom-Json; $pin = $pins.node.$arch;" ^
  "$stem = 'node-v24.21.0-win-' + $arch;" ^
  "if ($pins.node.version -ne '24.21.0' -or $pin.url -ne ('https://nodejs.org/dist/v24.21.0/' + $stem + '.zip') -or $pin.sha256 -notmatch '^[a-f0-9]{64}$' -or $pins.node.maxBytes -ne 104857600) { throw 'Artifact pin rejected' };" ^
  "$request = [Net.HttpWebRequest]::Create($pin.url); $request.AllowAutoRedirect = $false; $request.Timeout = 60000; $request.ReadWriteTimeout = 10000;" ^
  "$watch = [Diagnostics.Stopwatch]::StartNew(); $response = $null; $output = $null; $input = $null;" ^
  "try {" ^
  "  $response = $request.GetResponse(); if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 104857600) { throw 'Download rejected' };" ^
  "  $input = $response.GetResponseStream(); $output = [IO.File]::Open((Join-Path $tools 'node.zip'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);" ^
  "  $buffer = New-Object byte[] 65536; $total = 0;" ^
  "  while (($count = $input.Read($buffer,0,$buffer.Length)) -gt 0) { $total += $count; if ($total -gt 104857600 -or $watch.ElapsedMilliseconds -gt 60000) { throw 'Download bound exceeded' }; $output.Write($buffer,0,$count) };" ^
  "  if ($total -eq 0 -or ($response.ContentLength -ge 0 -and $response.ContentLength -ne $total) -or $watch.ElapsedMilliseconds -gt 60000) { throw 'Download truncated or timed out' };" ^
  "} finally { if ($output) { $output.Dispose() }; if ($input) { $input.Dispose() }; if ($response) { $response.Dispose() } };" ^
  "$actual = (Get-FileHash -LiteralPath (Join-Path $tools 'node.zip') -Algorithm SHA256).Hash; if ($actual -ne $pin.sha256) { throw 'Integrity mismatch' };" ^
  "$null = New-Item -ItemType File -Path (Join-Path $tools '.node-stem') -Value $stem;" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: Node download, bounds, integrity or policy check failed.'); exit 1 } }"
if errorlevel 1 goto failed

rem Inspect the entire ZIP namespace before extracting ONLY its regular node.exe.
rem Reject links, Windows device/ADS names, traversal and case aliases.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; if (Test-Path -LiteralPath (Join-Path $tools '.node-target')) { exit 0 };" ^
  "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
  "$stem = (Get-Content -LiteralPath (Join-Path $tools '.node-stem') -Raw).Trim();" ^
  "$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $tools 'node.zip'));" ^
  "try {" ^
  "  if ($zip.Entries.Count -eq 0 -or $zip.Entries.Count -gt 50000) { throw 'ZIP count rejected' };" ^
  "  $explicit = @{}; $names = @{}; $types = @{}; $selected = $null; $expanded = 0;" ^
  "  foreach ($entry in $zip.Entries) {" ^
  "    $name = $entry.FullName; $directory = $name.EndsWith('/'); if ($directory) { $name = $name.Substring(0,$name.Length - 1) };" ^
  "    $unixType = ($entry.ExternalAttributes -shr 16) -band 61440;" ^
  "    if (($entry.ExternalAttributes -band 1024) -or ($unixType -ne 0 -and $unixType -ne 32768 -and $unixType -ne 16384) -or ($unixType -eq 16384 -and -not $directory) -or ($directory -and $entry.Length -ne 0)) { throw 'ZIP links/types rejected' };" ^
  "    if ($entry.FullName.Contains('\') -or $explicit.ContainsKey($name)) { throw 'ZIP duplicate/path rejected' }; $explicit[$name] = $true;" ^
  "    $parts = $name.Split('/'); $path = '';" ^
  "    for ($index = 0; $index -lt $parts.Length; $index++) {" ^
  "      $part = $parts[$index];" ^
  "      if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:\x22|?*\x00-\x1f\x7f]' -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(\.|$)') { throw 'ZIP Windows name rejected' };" ^
  "      if ($path) { $path += '/' }; $path += $part; $isDirectory = $directory -or $index -lt ($parts.Length - 1);" ^
  "      if ($names.ContainsKey($path) -and ($names[$path] -cne $path -or $types[$path] -ne $isDirectory)) { throw 'ZIP case/type alias rejected' }; $names[$path] = $path; $types[$path] = $isDirectory;" ^
  "    };" ^
  "    $expanded += $entry.Length; if ($expanded -gt 536870912 -or ($name -ne $stem -and -not $name.StartsWith($stem + '/',[StringComparison]::Ordinal))) { throw 'ZIP root/size rejected' };" ^
  "    if ($name -ceq ($stem + '/node.exe')) { if ($directory -or $entry.Length -eq 0 -or $entry.Length -gt 157286400) { throw 'Node member rejected' }; $selected = $entry };" ^
  "  }; if ($null -eq $selected) { throw 'Node member missing' };" ^
  "  $destination = Join-Path $tools 'node'; $null = New-Item -ItemType Directory -Path $destination;" ^
  "  $target = Join-Path $destination 'node.exe'; $output = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $input = $selected.Open();" ^
  "  try { $input.CopyTo($output) } finally { $input.Dispose(); $output.Dispose() };" ^
  "  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($target); $record = [IO.File]::Open((Join-Path $tools '.node-target'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try { $record.Write($bytes,0,$bytes.Length) } finally { $record.Dispose() };" ^
  "} finally { $zip.Dispose() };" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: Node ZIP namespace, extraction or policy check failed.'); exit 1 } }"
if errorlevel 1 goto failed

rem Production direct non-forking Node probe: 10s deadline and combined 1-MiB cap.
rem Drain both pipes asynchronously; valid output followed by a hang still fails.
rem Failures append one fixed reason code; walk codes name the component role only.
rem .node-target holds a possibly non-ASCII path: written and read as explicit UTF-8.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { $child = $null; $started = $false; $step = 'policy'; try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'policy' };" ^
  "$step = 'target'; $tools = $env:GENTLE_BOOTSTRAP_TOOLS; $record = Join-Path $tools '.node-target'; if (-not [IO.File]::Exists($record)) { throw 'missing-target' };" ^
  "$node = [IO.File]::ReadAllText($record,[Text.Encoding]::UTF8).TrimEnd([char]13,[char]10); if (-not $node) { throw 'missing-target' };" ^
  "$item = Get-Item -LiteralPath $node -Force; if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe-target' };" ^
  "if (-not [IO.Path]::IsPathRooted($node) -or $node.StartsWith('\\')) { throw 'unsafe-path' };" ^
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted = @($me,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'); $path = $node;" ^
  "$depth = 0;" ^
  "$step = 'acl-walk'; while ($path) {" ^
  "  $role = 'ancestor'; if ($depth -eq 0) { $role = 'target' } elseif ($depth -eq 1) { $role = 'parent' };" ^
  "  $item = Get-Item -LiteralPath $path -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ($role + '-reparse') };" ^
  "  if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) };" ^
  "  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw ($role + '-owner') };" ^
  "  $allowedRights = 0x1200a9; if ($depth -ge 2) { $allowedRights = 0x1200ad };" ^
  "  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([long]$rule.FileSystemRights -band (-bnot [long]$allowedRights)) -and $trusted -notcontains $rule.IdentityReference.Value) { throw ($role + '-acl-mask') } };" ^
  "  $parent = [IO.Directory]::GetParent($path); if ($null -eq $parent) { break }; $path = $parent.FullName; $depth++;" ^
  "};" ^
  "$start = New-Object Diagnostics.ProcessStartInfo; $start.FileName = $node; $start.Arguments = '--version'; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true;" ^
  "$step = 'start'; $child = New-Object Diagnostics.Process; $child.StartInfo = $start; if (-not $child.Start()) { throw 'no-start' }; $started = $true;" ^
  "$step = 'drain'; $streams = @($child.StandardOutput.BaseStream,$child.StandardError.BaseStream); $buffers = @((New-Object byte[] 4096),(New-Object byte[] 4096));" ^
  "$tasks = @($streams[0].ReadAsync($buffers[0],0,4096),$streams[1].ReadAsync($buffers[1],0,4096)); $closed = @($false,$false); $text = ''; $total = 0; $watch = [Diagnostics.Stopwatch]::StartNew();" ^
  "while (-not ($closed[0] -and $closed[1] -and $child.HasExited)) {" ^
  "  if ($watch.ElapsedMilliseconds -ge 10000) { throw 'deadline' };" ^
  "  for ($index = 0; $index -lt 2; $index++) { if (-not $closed[$index] -and $tasks[$index].IsCompleted) {" ^
  "    $count = $tasks[$index].GetAwaiter().GetResult(); if ($count -eq 0) { $closed[$index] = $true } else {" ^
  "      $total += $count; if ($total -gt 1048576) { throw 'output-limit' };" ^
  "      if ($index -eq 0) { $text += [Text.Encoding]::UTF8.GetString($buffers[$index],0,$count) };" ^
  "      $tasks[$index] = $streams[$index].ReadAsync($buffers[$index],0,4096);" ^
  "    }" ^
  "  } }; Start-Sleep -Milliseconds 10;" ^
  "}; if ($child.ExitCode -ne 0) { throw 'exit-code' };" ^
  "$step = 'version'; $version = $text.Trim(); if ($version -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'version-format' };" ^
  "$actual = [Version]$version.Substring(1); $metadata = Get-Content -LiteralPath (Join-Path $env:GENTLE_BOOTSTRAP_BUNDLE 'package.json') -Raw | ConvertFrom-Json;" ^
  "if ($actual -lt [Version]'24.3.0' -or $actual -lt [Version]$metadata.engines.node.Substring(2)) { throw 'engine' };" ^
  "if ((Test-Path -LiteralPath (Join-Path $tools '.node-stem')) -and $version -ne 'v24.21.0') { throw 'acquired-version' };" ^
  "} catch { $reason = 'unexpected-' + $step; if ($_.Exception.Message -cmatch '^(policy|missing-target|unsafe-target|unsafe-path|(target|parent|ancestor)-(reparse|owner|acl-mask)|no-start|deadline|output-limit|exit-code|version-format|engine|acquired-version)$') { $reason = $_.Exception.Message };" ^
  "[Console]::Error.WriteLine('Bootstrap: Node version, execution, deadline, output bound or policy check failed; refusing replacement. Reason: ' + $reason); exit 1 }" ^
  "finally { try { if ($child) { if ($started -and -not $child.HasExited) { $child.Kill(); if (-not $child.WaitForExit(1000)) { throw 'Child termination unconfirmed' } }; $child.Dispose() } } catch { [Console]::Error.WriteLine('Bootstrap: direct-child termination could not be confirmed.'); exit 1 } } }"
if errorlevel 1 goto failed

rem Launch the existing Node helper with data arguments; no shell evaluation.
rem Interactive wizard duration is intentionally unbounded. Only child PATH changes.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; $record = Join-Path $tools '.node-target'; $node = [IO.File]::ReadAllText($record,[Text.Encoding]::UTF8).TrimEnd([char]13,[char]10);" ^
  "$env:PATH = [IO.Path]::GetDirectoryName($node) + ';' + $env:PATH;" ^
  "$helper = Join-Path $env:GENTLE_BOOTSTRAP_BUNDLE 'scripts/installer-downloads.mjs';" ^
  "if (Test-Path -LiteralPath (Join-Path $tools 'node.zip')) { Remove-Item -LiteralPath (Join-Path $tools 'node.zip') };" ^
  "& $node $helper '--bootstrap-windows' $env:GENTLE_BOOTSTRAP_BUNDLE $tools; if ($LASTEXITCODE -ne 0) { throw 'Helper failed' };" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: prerequisite helper/wizard failed or managed policy denied execution.'); exit 1 } }"
if errorlevel 1 goto failed

rem Success: node/npm/pnpm now persist under PNPM_HOME or were already the user's.
rem Remove only our exact claimed, marked root; Directory.Delete does not recurse
rem through reparse points. A removal problem never fails the installation.
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$tools = [IO.Path]::GetFullPath($env:GENTLE_BOOTSTRAP_TOOLS); $parent = [IO.Directory]::GetParent($tools).FullName;" ^
  "if ($tools.StartsWith('\\') -or $parent -ne [IO.Path]::GetFullPath($env:LOCALAPPDATA) -or -not [IO.Path]::GetFileName($tools).StartsWith('.gentle-shell-bootstrap-tools.',[StringComparison]::Ordinal)) { throw 'Cleanup target rejected' };" ^
  "$item = Get-Item -LiteralPath $tools -Force;" ^
  "if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Cleanup target rejected' };" ^
  "$marker = Get-Item -LiteralPath (Join-Path $tools '.bootstrap-owned') -Force;" ^
  "if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-Content -LiteralPath $marker.FullName -Raw) -ne 'gentle-pi prerequisite tooling only') { throw 'Cleanup marker rejected' };" ^
  "[IO.Directory]::Delete($tools, $true);" ^
  "} catch { $message = 'Bootstrap: installation finished, but temporary tools could not be removed: ' + $env:GENTLE_BOOTSTRAP_TOOLS;" ^
  "if ([Console]::IsErrorRedirected) { $bytes = [Text.Encoding]::UTF8.GetBytes($message + [Environment]::NewLine); $stderr = [Console]::OpenStandardError(); $stderr.Write($bytes, 0, $bytes.Length); $stderr.Flush() } else { [Console]::Error.WriteLine($message) }; exit 1 } }"
endlocal & exit /b 0

:unavailable
>&2 echo Bootstrap: stock Windows PowerShell is unavailable. No acquisition attempted.
:failed
rem Never scan/reuse/clean other attempts. Only our successfully claimed root.
if not defined GENTLE_BOOTSTRAP_OWNED goto finishfailure
"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { try { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Managed policy constraint' };" ^
  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; $item = Get-Item -LiteralPath $tools -Force;" ^
  "if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Cleanup target rejected' };" ^
  "$marker = Get-Item -LiteralPath (Join-Path $tools '.bootstrap-owned') -Force;" ^
  "if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-Content -LiteralPath $marker.FullName -Raw) -ne 'gentle-pi prerequisite tooling only') { throw 'Cleanup marker rejected' };" ^
  "Remove-Item -LiteralPath $tools -Recurse -Force;" ^
  "} catch { [Console]::Error.WriteLine('Bootstrap: attempt-owned cleanup unavailable; no other storage touched.'); exit 1 } }"
:finishfailure
endlocal & exit /b 1
