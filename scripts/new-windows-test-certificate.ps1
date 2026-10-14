param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.scratch/windows-test-certificate' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith(($projectRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Public certificate output must stay inside the project.' }
$manifestPath = Join-Path $output 'certificate.json'
$certificate = $null
if (Test-Path -LiteralPath $manifestPath) {
    $previous = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($previous.thumbprint -notmatch '^[0-9A-Fa-f]{40}$' -or $previous.testOnly -ne $true) { throw 'Invalid existing test certificate manifest.' }
    $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $previous.thumbprint)
    if ($certificate.Subject -ne 'CN=YuanTu Local Test Code Signing' -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date)) { throw 'Existing test certificate is missing, expired or inconsistent; retain it for inspection.' }
} else {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=YuanTu Local Test Code Signing' -FriendlyName 'YuanTu local testing only' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -Provider 'Microsoft Software Key Storage Provider' -NotAfter (Get-Date).AddYears(1)
}
if (-not ($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })) { throw 'Test certificate lacks Code Signing EKU.' }
$privateKey = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
try { if ($privateKey.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) { throw 'Test private key must be non-exportable.' } } finally { $privateKey.Dispose() }
New-Item -ItemType Directory -Force -Path $output | Out-Null
Export-Certificate -Cert $certificate -FilePath (Join-Path $output 'yuantu-local-test.cer') -Type CERT | Out-Null
$sha = [Security.Cryptography.SHA256]::Create()
try { $signer = ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
@{ version = 1; testOnly = $true; subject = $certificate.Subject; thumbprint = $certificate.Thumbprint; signerSha256 = $signer; store = 'CurrentUser/My'; privateKeyExportable = $false; systemTrustInstalled = $false; notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o'); publicCertificate = 'yuantu-local-test.cer' } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output ('Local test certificate ready: ' + $certificate.Thumbprint + '. Private key stays in CurrentUser/My; no trust-store import performed.')
