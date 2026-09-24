param(
	[Parameter(Mandatory = $true)]
	[string]$SourcePath
)

$maxEntries = 8
$maxLocation = 1000000
$stage = 'control-failure'
$outcome = 'not-compiled'
$sourceExtracted = $false
$success = $false
$errorList = [System.Collections.Generic.List[object]]::new()
$warningList = [System.Collections.Generic.List[object]]::new()
$tempRoot = $null
$tempFiles = $null
$provider = $null

function Add-CompilerEntry([System.Collections.Generic.List[object]]$entries, [object]$compilerError) {
	if ($entries.Count -ge $maxEntries) { return }
	$code = [string]$compilerError.ErrorNumber
	if ($code -cnotmatch '\ACS[0-9]{4}\z') { return }
	$line = 0
	$column = 0
	try { $line = [Convert]::ToInt32($compilerError.Line) } catch {}
	try { $column = [Convert]::ToInt32($compilerError.Column) } catch {}
	if ($line -lt 0 -or $line -gt $maxLocation) { $line = 0 }
	if ($column -lt 0 -or $column -gt $maxLocation) { $column = 0 }
	$entries.Add([pscustomobject]@{ code = $code; line = $line; column = $column })
}

function Get-AddTypeLiteral([System.Management.Automation.Language.Ast]$ast) {
	$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Add-Type' }, $true))
	if ($commands.Count -ne 1) { return $null }
	$values = [System.Collections.Generic.List[string]]::new()
	$elements = $commands[0].CommandElements
	for ($index = 0; $index -lt $elements.Count; $index++) {
		$element = $elements[$index]
		if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or $element.ParameterName -cne 'TypeDefinition') { continue }
		if ($index + 1 -ge $elements.Count -or $elements[$index + 1] -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $null }
		$values.Add([string]$elements[$index + 1].Value)
	}
	if ($values.Count -ne 1 -or [string]::IsNullOrEmpty($values[0])) { return $null }
	return $values[0]
}

try {
	$resolvedSource = (Resolve-Path -LiteralPath $SourcePath -ErrorAction Stop).Path
	$tokens = $null
	$parseErrors = $null
	$ast = [System.Management.Automation.Language.Parser]::ParseFile($resolvedSource, [ref]$tokens, [ref]$parseErrors)
	if ($null -eq $ast -or $null -eq $parseErrors -or $parseErrors.Count -ne 0) {
		$stage = 'source-parse'
	} else {
		$literal = Get-AddTypeLiteral $ast
		if ($null -eq $literal) {
			$stage = 'source-contract'
		} else {
			$sourceExtracted = $true
			$tempRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('gentle-pi-csharp-control-' + [Guid]::NewGuid().ToString('N')))
			[void][IO.Directory]::CreateDirectory($tempRoot)
			$tempFiles = [System.CodeDom.Compiler.TempFileCollection]::new($tempRoot, $false)
			$parameters = [System.CodeDom.Compiler.CompilerParameters]::new()
			$parameters.GenerateExecutable = $false
			$parameters.GenerateInMemory = $true
			$parameters.TempFiles = $tempFiles
			# This Framework baseline is a compile-control comparison, not proof that Add-Type uses an identical reference set.
			[void]$parameters.ReferencedAssemblies.Add("System.dll")
			[void]$parameters.ReferencedAssemblies.Add("System.Core.dll")
			$provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
			$result = $provider.CompileAssemblyFromSource($parameters, $literal)
			$hasCompilerErrors = $false
			foreach ($compilerError in $result.Errors) {
				if ($compilerError.IsWarning) { Add-CompilerEntry $warningList $compilerError }
				else { $hasCompilerErrors = $true; Add-CompilerEntry $errorList $compilerError }
			}
			if ($hasCompilerErrors -and $errorList.Count -eq 0) { throw [InvalidOperationException]::new('CSharp compiler error had no reportable code') }
			$stage = if ($hasCompilerErrors) { 'compile' } else { 'completed' }
			$outcome = if ($hasCompilerErrors) { 'compile-errors' } else { 'compile-success' }
			$success = -not $hasCompilerErrors
		}
	}
} catch {
	$stage = 'control-failure'
	$success = $false
} finally {
	$cleanupFailed = $false
	if ($null -ne $provider) { try { $provider.Dispose() } catch { $cleanupFailed = $true } }
	if ($null -ne $tempFiles) { try { $tempFiles.Dispose() } catch { $cleanupFailed = $true } }
	if ($null -ne $tempRoot) { try { if ([IO.Directory]::Exists($tempRoot)) { [IO.Directory]::Delete($tempRoot, $true) } } catch { $cleanupFailed = $true } }
	if ($cleanupFailed) {
		$stage = 'control-failure'
		$outcome = 'not-compiled'
		$success = $false
		$errorList.Clear()
		$warningList.Clear()
	}
	$record = [ordered]@{
		kind = 'windows-session-csharp-compile-control'
		success = $success
		sourceExtracted = $sourceExtracted
		stage = $stage
		outcome = $outcome
		errorlist = @($errorList.ToArray())
	}
	if ($warningList.Count -gt 0) { $record.warnings = @($warningList.ToArray()) }
	[Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 3))
}

if ($success) { exit 0 }
exit 1
