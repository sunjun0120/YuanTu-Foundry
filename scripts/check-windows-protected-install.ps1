param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [ValidateSet('installed', 'before-upgrade', 'before-uninstall')][string]$Phase = 'installed',
    [Parameter(Mandatory = $true)][string]$ExpectedSignerSha256
)
$ErrorActionPreference = 'Stop'
if ($ExpectedSignerSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Expected signer must be a SHA256 certificate identity.' }
$programFiles = [Environment]::GetEnvironmentVariable('ProgramW6432')
if (-not $programFiles) { $programFiles = [Environment]::GetFolderPath('ProgramFiles') }
$expected = [IO.Path]::GetFullPath((Join-Path $programFiles 'YuanTu Agent'))
$root = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($root -ne $expected) { throw 'Protected installation must use the fixed Program Files directory.' }
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Assert-ProtectedItem([string]$ItemPath, [bool]$Ancestor = $false) {
    $item = Get-Item -LiteralPath $ItemPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse installation path: ' + $ItemPath) }
    $acl = Get-Acl -LiteralPath $ItemPath
    if ($trustedOwners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw ('Untrusted installation owner: ' + $ItemPath) }
    $writes = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    if (-not $Ancestor) { $writes = $writes -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -and $trustedOwners -notcontains $rule.IdentityReference.Value) { throw ('Non-administrator mutation rights: ' + $ItemPath) }
    }
}
$component = Get-Item -LiteralPath $root -Force
while ($component) { Assert-ProtectedItem $component.FullName ($component.FullName -ne $root); $component = $component.Parent }
# Reparse entries are checked before descending; do not follow junctions.
$pending = New-Object 'System.Collections.Generic.Queue[string]'
$pending.Enqueue($root)
while ($pending.Count) {
    $directory = $pending.Dequeue()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        Assert-ProtectedItem $item.FullName
        if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
    }
}
$runtime = Join-Path $root 'resources/runtime'
$manifest = Get-Content -LiteralPath (Join-Path $runtime 'runtime.json') -Raw | ConvertFrom-Json
if ($manifest.profile -ne 'official' -or $manifest.selection -ne 'candidate') { throw 'Protected install requires the release-signed official runtime candidate.' }
$helper = Join-Path $root 'resources/app/dist/packages/tools/windows-sandbox/yuantu-sandbox.exe'
$compiledSigning = Get-Content -LiteralPath (Join-Path $root 'resources/app/dist/packages/tools/windows-sandbox/helper-signature.json') -Raw | ConvertFrom-Json
if ($compiledSigning.accountHelperSha256 -ne $manifest.signedHelper.accountHelperSha256 -or $compiledSigning.signerSha256 -ne $ExpectedSignerSha256) { throw 'Installed signing assets differ from the pinned helper manifest.' }
foreach ($asset in @(
    @{ file = (Join-Path $runtime 'node.exe'); hash = $manifest.sha256 },
    @{ file = (Join-Path $runtime 'LICENSE.node'); hash = $manifest.licenseSha256 },
    @{ file = (Join-Path $runtime 'provenance.json'); hash = $manifest.provenanceSha256 },
    @{ file = $helper; hash = $manifest.signedHelper.accountHelperSha256 }
)) {
    if ((Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.hash) { throw ('Installed asset hash changed: ' + $asset.file) }
}
foreach ($file in @($helper, (Join-Path $runtime 'node.exe'), (Join-Path $root 'YuanTu Agent.exe'))) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or $signature.SignerCertificate.Subject -eq $signature.SignerCertificate.Issuer) { throw ('Installed asset needs a trusted production signature and timestamp: ' + $file) }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $signer = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($signer -ne $ExpectedSignerSha256) { throw ('Installed signer differs from pin: ' + $file) }
}
if ($Phase -ne 'installed') {
    # This remains conservative even if the current user's journals are empty:
    # another user's descendants or an installed WFP policy may still exist.
    throw 'Protected upgrade/uninstall remains blocked until multi-user descendant shutdown and crash-safe WFP lifecycle acceptance in a recoverable Windows environment.'
}
# The native check also verifies hardlinks, loader protection and pinned path handles.
& $helper install-preflight
if ($LASTEXITCODE -ne 0) { throw 'Native protected-install preflight failed.' }
Write-Output 'Protected installed assets and native preflight passed. No sandbox account or network policy changed.'
