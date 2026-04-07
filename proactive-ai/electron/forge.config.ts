import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Proactive AI',
    executableName: 'proactive-ai',
    appBundleId: 'ai.pin.proactive-ai',
    darwinDarkModeSupport: true,
    // osxSign: {},  // Uncomment when you have an Apple Developer certificate
    extraResource: [
      // Built by scripts/build-dmg.sh — self-contained plugin + runtime
      './.bundle/plugin',
      './.bundle/runtime',
    ],
  },
  makers: [
    { name: '@electron-forge/maker-dmg', config: {} },
    { name: '@electron-forge/maker-zip', config: {}, platforms: ['darwin'] },
  ],
};

export default config;
