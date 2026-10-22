param(
    [string]$CertificateThumbprint,
    [ValidateSet('CurrentUser', 'LocalMachine')][string]$CertificateStore = 'CurrentUser',
    [string]$SignToolPath,
    [string]$TimestampUrl,
    [string]$RuntimeCandidateDirectory,
    [switch]$Check,
    [switch]$Sign,
    [switch]$TestOnly
)
$ErrorActionPreference = 'Stop'
if (-not $CertificateThumbprint) {
    [Console]::Error.WriteLine('Missing code-signing certificate. Supply CertificateThumbprint from the local certificate store; no PFX password is accepted.')
    exit 2
}
if ($CertificateThumbprint -notmatch '^[0-9a-fA-F]{40}$') { throw 'CertificateThumbprint must be the certificate SHA-1 thumbprint (40 hex digits).' }
if ($Check -and $Sign) { throw 'Choose Check or Sign.' }
$certificatePath = 'Cert:\' + $CertificateStore + '\My\' + $CertificateThumbprint
$certificate = Get-Item -LiteralPath $certificatePath
if (-not $certificate.HasPrivateKey) { throw 'The code-signing certificate has no local private key.' }
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -lt (Get-Date)) { throw 'The code-signing certificate is not currently valid.' }
if (-not ($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })) { throw 'Certificate lacks the Code Signing EKU.' }
if (-not $SignToolPath) {
    $signToolCommand = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($signToolCommand) { $SignToolPath = $signToolCommand.Source }
}
if (-not $SignToolPath -or -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw 'Provide SignToolPath from the Windows SDK.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $signerDigest = ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
if (-not $Sign) {
    @{ readyToSign = $true; productionReady = ($certificate.Subject -ne $certificate.Issuer); signerSha256 = $signerDigest; certificateStore = $CertificateStore } | ConvertTo-Json
    exit 0
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($TestOnly) {
    if ($certificate.Subject -ne 'CN=YuanTu Local Test Code Signing' -or $certificate.Subject -ne $certificate.Issuer) { throw 'TestOnly signing requires the dedicated self-signed local test certificate.' }
    $testDirectory = Join-Path $projectRoot '.scratch/windows-sandbox-test-signing'
    New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
    $assets = @(
        @{ source = (Join-Path $projectRoot 'packages/tools/windows-sandbox/yuantu-sandbox.exe'); name = 'yuantu-sandbox.exe' },
        @{ source = (Join-Path $projectRoot '.scratch/windows-runtime/node-v24.19.0-win-x64/node.exe'); name = 'node.exe' }
    )
    $results = @()
    foreach ($asset in $assets) {
        $destination = Join-Path $testDirectory $asset.name
        Copy-Item -LiteralPath $asset.source -Destination $destination -Force
        $testArguments = @('sign', '/fd', 'SHA256', '/sha1', $CertificateThumbprint, '/s', 'My')
        if ($CertificateStore -eq 'LocalMachine') { $testArguments += '/sm' }
        & $SignToolPath @testArguments $destination
        if ($LASTEXITCODE -ne 0) { throw 'Local test signing failed.' }
        $testSignature = Get-AuthenticodeSignature -LiteralPath $destination
        if (-not $testSignature.SignerCertificate -or $testSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $testSignature.Status -ne 'UnknownError') {
            # Windows versions report an untrusted self-signed chain as UnknownError or NotTrusted.
            if (-not $testSignature.SignerCertificate -or $testSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $testSignature.Status -notin @('NotTrusted', 'Valid')) { throw 'Test signature does not match the selected test signer.' }
        }
        $results += @{ file = $asset.name; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant(); signatureStatus = [string]$testSignature.Status }
    }
    @{ version = 1; testOnly = $true; releaseReady = $false; timestamped = $false; signerSha256 = $signerDigest; assets = $results } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $testDirectory 'manifest.json') -Encoding utf8
    Write-Output 'Local test signatures prepared in scratch only. Production assets, trust stores and WFP are unchanged.'
    exit 0
}
if ($certificate.Subject -eq $certificate.Issuer) { throw 'Production signing refuses a self-signed test certificate.' }
$timestampUri = $null
if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestampUri) -or $timestampUri.Scheme -ne 'https' -or $timestampUri.UserInfo) { throw 'Sign requires an explicit HTTPS RFC3161 TimestampUrl without credentials.' }
$nodeExecutable = (Get-Command node.exe).Source
$signingDirectory = Join-Path $projectRoot '.scratch/windows-sandbox-signing'
$helperBuildDirectory = Join-Path $signingDirectory 'build'
New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null
$oldSigner = [Environment]::GetEnvironmentVariable('YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256', 'Process')
try {
    [Environment]::SetEnvironmentVariable('YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256', $signerDigest, 'Process')
    & $nodeExecutable (Join-Path $PSScriptRoot 'build-windows-sandbox.mjs') ('--output-directory=' + $helperBuildDirectory)
    if ($LASTEXITCODE -ne 0) { throw 'Pinned helper build failed.' }
} finally {
    [Environment]::SetEnvironmentVariable('YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256', $oldSigner, 'Process')
}
$helperDigests = @{}
foreach ($helperName in @('yuantu-sandbox.exe')) {
    $signedHelper = Join-Path $signingDirectory $helperName
    Copy-Item -LiteralPath (Join-Path $helperBuildDirectory $helperName) -Destination $signedHelper -Force
    $signArguments = @('sign', '/fd', 'SHA256', '/sha1', $CertificateThumbprint, '/s', 'My', '/tr', $timestampUri.AbsoluteUri, '/td', 'SHA256')
    if ($CertificateStore -eq 'LocalMachine') { $signArguments += '/sm' }
    & $SignToolPath @signArguments $signedHelper
    if ($LASTEXITCODE -ne 0) { throw "Helper signing or timestamping failed: $helperName" }
    & $SignToolPath verify /pa /all $signedHelper
    if ($LASTEXITCODE -ne 0) { throw "Helper Authenticode verification failed: $helperName" }
    $signature = Get-AuthenticodeSignature -LiteralPath $signedHelper
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) { throw "Helper needs a valid signature and timestamp: $helperName" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualSigner = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actualSigner -ne $signerDigest) { throw "Signed helper does not match the compiled signer pin: $helperName" }
    $helperDigests[$helperName] = (Get-FileHash -LiteralPath $signedHelper -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($RuntimeCandidateDirectory) {
    $runtimeDirectory = [IO.Path]::GetFullPath($RuntimeCandidateDirectory)
    if (-not $runtimeDirectory.StartsWith(($projectRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime signing must stay inside the project.' }
    $provenancePath = Join-Path $runtimeDirectory 'provenance.json'
    $runtimeProvenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    if ($runtimeProvenance.profile -ne 'official' -or $runtimeProvenance.source.signedChecksumsVerified -ne $true) { throw 'Only a verified official Node runtime may receive release signing.' }
    if ($runtimeProvenance.binary.upstreamSha256) { throw 'Runtime already carries release signing; prepare a fresh official candidate.' }
    $runtimeInput = Join-Path $runtimeDirectory 'node.exe'
    $upstreamDigest = (Get-FileHash -LiteralPath $runtimeInput -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($upstreamDigest -ne $runtimeProvenance.binary.sha256) { throw 'Runtime changed before signing.' }
    $signedRuntime = Join-Path $signingDirectory 'node.exe'
    Copy-Item -LiteralPath $runtimeInput -Destination $signedRuntime -Force
    $runtimeArguments = @('sign', '/fd', 'SHA256', '/sha1', $CertificateThumbprint, '/s', 'My', '/tr', $timestampUri.AbsoluteUri, '/td', 'SHA256')
    if ($CertificateStore -eq 'LocalMachine') { $runtimeArguments += '/sm' }
    & $SignToolPath @runtimeArguments $signedRuntime
    if ($LASTEXITCODE -ne 0) { throw 'Production Node signing failed.' }
    & $SignToolPath verify /pa /all $signedRuntime
    if ($LASTEXITCODE -ne 0) { throw 'Production Node verification failed.' }
    $runtimeSignature = Get-AuthenticodeSignature -LiteralPath $signedRuntime
    if ($runtimeSignature.Status -ne 'Valid' -or -not $runtimeSignature.TimeStamperCertificate -or $runtimeSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Production Node needs the same trusted signer and timestamp.' }
    Copy-Item -LiteralPath $signedRuntime -Destination $runtimeInput -Force
    # Replaces the OpenJS Foundation signature with the pinned release signer; the upstream bytes stay recorded.
    $runtimeProvenance.binary | Add-Member -NotePropertyName upstreamSha256 -NotePropertyValue $upstreamDigest -Force
    $runtimeProvenance.binary.sha256 = (Get-FileHash -LiteralPath $runtimeInput -Algorithm SHA256).Hash.ToLowerInvariant()
    $runtimeProvenance.binary | Add-Member -NotePropertyName authenticode -NotePropertyValue 'Valid' -Force
    $runtimeProvenance.binary | Add-Member -NotePropertyName signerSha256 -NotePropertyValue $signerDigest -Force
    $runtimeProvenance | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $provenancePath -Encoding utf8
}
foreach ($helperName in @('yuantu-sandbox.exe')) {
    $compiledHelper = Join-Path $projectRoot ('dist/packages/tools/windows-sandbox/' + $helperName)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $compiledHelper) | Out-Null
    $signedHelper = Join-Path $signingDirectory $helperName
    Copy-Item -LiteralPath $signedHelper -Destination (Join-Path $projectRoot ('packages/tools/windows-sandbox/' + $helperName)) -Force
    Copy-Item -LiteralPath $signedHelper -Destination $compiledHelper -Force
}
@{ version = 1; signerSha256 = $signerDigest; accountHelperSha256 = $helperDigests['yuantu-sandbox.exe']; timestamped = $true; signedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $signingDirectory 'manifest.json')
Write-Output 'Signed pinned helper prepared. This does not initialize sandbox accounts or WFP.'
