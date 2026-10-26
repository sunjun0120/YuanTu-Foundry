module.exports = {
  appId: 'com.yuantu.agent',
  productName: 'YuanTu Agent',
  extraMetadata: { main: 'dist/desktop/main.cjs' },
  directories: { output: 'dist/release', buildResources: 'build' },
  icon: 'build/icon.png',
  /**
   * No asar archive, on purpose. The Agent Host does not run inside Electron: it is started with the bundled
   * standalone Node (`runtime/`), and so are its workers, the program runner and the sandbox helpers — and a plain
   * Node process cannot read files out of an asar archive. Packing would mean unpacking `dist/packages` and every
   * native module again, which is the same file layout with an extra indirection.
   */
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
    // The CLI ships through the npm `bin`, not inside the desktop bundle.
    '!dist/apps/cli/**/*',
    '!dist/**/*.map',
    '!dist/**/*.d.ts',
    /**
     * `@napi-rs/canvas` is an optional dependency of `pdfjs-dist`, used to polyfill `DOMMatrix` and `Path2D`
     * for *rendering* pages. The desktop only extracts a PDF attachment's text, which works without it (pdfjs
     * warns that rendering may be broken and carries on), so its ~36 MB native binary stays out of the package.
     */
    '!node_modules/@napi-rs/canvas/**',
    '!node_modules/@napi-rs/canvas-*/**',
  ],
  extraResources: [
    { from: '.scratch/packaging/runtime', to: 'runtime' },
    /**
     * The verified search binary, staged per target by `scripts/copy-search-assets.mjs`.
     *
     * It lands beside `app.asar` rather than inside it, next to the runtime for the same reason: it is a program
     * the application *executes*, and the runtime resolves it from `process.resourcesPath` and checks its digest
     * against the checked-in lock before running it. A platform with no pinned asset stages an empty directory
     * with a note, and the search tool uses its built-in scanner instead.
     */
    { from: '.scratch/packaging/search-assets', to: 'search-assets' },
  ],
  // A copied standalone Node is architecture-specific; never silently cross-package it.
  beforePack: async (context) => {
    if (context.electronPlatformName === 'win32') {
      if (process.platform === 'win32') {
        // NSIS validates TEMP before running installer hooks; custom system locations can fail with exit code 2.
        // Change only this build process's environment, keeping its temporary files in the workspace.
        const temporary = require('node:path').resolve('.scratch/packaging/nsis-temp');
        await require('node:fs/promises').mkdir(temporary, { recursive: true });
        process.env.TEMP = temporary;
        process.env.TMP = temporary;
      }
      const { validatePackagedWindowsRuntime } =
        await import('./scripts/windows-runtime-product.mjs');
      await validatePackagedWindowsRuntime(
        require('node:path').resolve('.scratch/packaging/runtime'),
      );
      return;
    }
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
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'win32') return;
    const { validateWindowsPackage } = await import('./scripts/check-windows-package.mjs');
    await validateWindowsPackage(context.appOutDir);
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
    // Removes the Windows sandbox accounts on uninstall (not on update); the app has no other place to remove them.
    include: 'build/installer.nsh',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    artifactName: 'YuanTu-Agent-${version}-windows-${arch}-setup.${ext}',
  },
};
