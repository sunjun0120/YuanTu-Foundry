param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-install-safety.ps1')
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scratchRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.scratch')) + [IO.Path]::DirectorySeparatorChar
$targetDirectory = [IO.Path]::GetFullPath($InstallDirectory)
if (-not $targetDirectory.StartsWith($scratchRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installation verification must stay inside this project .scratch directory'
}
$ancestor = $targetDirectory
while ($ancestor -and $ancestor.Length -ge $projectRoot.Length) {
  if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Verification directory must not traverse a junction or symbolic link'
  }
  $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
Assert-YuanTuInstallations @(Get-YuanTuInstallations) $targetDirectory
if ($Uninstall) {
  $uninstaller = Get-ChildItem -LiteralPath $targetDirectory -Filter '*uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { throw 'Verified installation has no uninstaller' }
  $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
  return
}
$resolvedInstaller = (Resolve-Path -LiteralPath $Installer).Path
$process = Start-Process -FilePath $resolvedInstaller -ArgumentList ('/S /D=' + $targetDirectory) -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
foreach ($relative in @('YuanTu Agent.exe', 'resources/runtime/node.exe', 'resources/app/dist/apps/agent-host/main.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $targetDirectory $relative))) { throw "Missing installed resource: $relative" }
}
[PSCustomObject]@{ installed = $targetDirectory; installer = $resolvedInstaller; exitCode = $process.ExitCode } | ConvertTo-Json
