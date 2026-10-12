module.exports = {
  appId: 'com.yuantu.agent',
  productName: 'YuanTu Agent',
  extraMetadata: { main: 'dist/desktop/main.cjs' },
  directories: { output: 'dist/release', buildResources: 'build' },
  icon: 'build/icon.png',
  asar: false,
  npmRebuild: false,
  // Package only compiled code, excluding release artifacts and unpacked apps.
  files: [
    'dist/apps/**/*',
    'dist/desktop/**/*',
    'dist/packages/**/*',
    'dist/program-runner/**/*',
    'package.json',
    'LICENSE',
    '!dist/**/*.map',
    '!dist/**/*.d.ts',
  ],
  extraResources: [{ from: '.scratch/packaging/runtime', to: 'runtime' }],
  // A copied standalone Node is architecture-specific; never silently cross-package it.
  beforePack: async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    const { Arch } = require('builder-util');
    const { assertMacRuntime, validateMacRuntime, validateMacRuntimeDependencies } =
      await import('./scripts/prepare-macos-package.mjs');
    const architecture = Arch[context.arch];
    assertMacRuntime(
      {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
      },
      architecture,
    );
    await validateMacRuntime(
      require('node:path').resolve('.scratch/packaging/runtime'),
      architecture,
    );
    await validateMacRuntimeDependencies(
      require('node:path').resolve('.scratch/packaging/runtime/node'),
    );
  },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    artifactName: 'YuanTu-Agent-${version}-macos-${arch}.${ext}',
    hardenedRuntime: true,
    // Identity and notarization credentials come from electron-builder's environment.
    notarize: true,
    entitlements:
      process.env.YUANTU_MAC_ENTITLEMENTS || '.scratch/packaging/entitlements.mac.plist',
    entitlementsInherit:
      process.env.YUANTU_MAC_ENTITLEMENTS_INHERIT ||
      process.env.YUANTU_MAC_ENTITLEMENTS ||
      '.scratch/packaging/entitlements.mac.plist',
    binaries: ['Contents/Resources/runtime/node'],
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    signExecutable: false,
  },
  nsis: {
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    artifactName: 'YuanTu-Agent-${version}-windows-${arch}-setup.${ext}',
  },
};
