const base = require('./electron-builder.config.cjs');
if (process.env.WINDOWS_SANDBOX_PROTECTED_RELEASE !== '1')
  throw new Error('Protected installer requires an explicit production invocation');
const certificate = process.env.WINDOWS_SIGN_CERTIFICATE_SHA1;
if (!/^[a-f0-9]{40}$/i.test(certificate || ''))
  throw new Error('Protected installer requires a local production signing certificate thumbprint');
const timestamp = new URL(process.env.WINDOWS_SIGN_TIMESTAMP_URL || 'invalid:');
if (timestamp.protocol !== 'https:' || timestamp.username || timestamp.password)
  throw new Error(
    'Protected installer requires an explicit HTTPS timestamp URL without credentials',
  );
module.exports = {
  ...base,
  forceCodeSigning: true,
  win: {
    ...base.win,
    signExecutable: true,
    // These are signed before hashing; signing them again invalidates provenance.
    signExts: ['!yuantu-appcontainer.exe', '!yuantu-sandbox.exe', '!node.exe'],
    signtoolOptions: {
      certificateSha1: certificate,
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: timestamp.href,
    },
  },
  afterSign: async (context) => {
    const { validateWindowsPackage } = await import('./scripts/check-windows-package.mjs');
    const { inspectHelperSignature } = await import('./scripts/check-windows-appcontainer.mjs');
    const path = require('node:path');
    const report = await validateWindowsPackage(context.appOutDir, { production: true });
    const signature = await inspectHelperSignature(
      path.join(context.appOutDir, 'YuanTu Agent.exe'),
    );
    if (
      !signature.valid ||
      !signature.timestamped ||
      signature.signerSha256 !== report.runtime.signedHelper.signerSha256
    )
      throw new Error('Protected desktop signature differs from the pinned helper signer');
  },
  nsis: {
    ...base.nsis,
    perMachine: true,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: false,
    include: 'build/windows-protected-install.nsh',
    artifactName: 'YuanTu-Agent-${version}-windows-${arch}-protected-setup.${ext}',
  },
};
