import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Proactive AI',
    executableName: 'proactive-ai',
    appBundleId: 'ai.pin.proactive-ai',
    darwinDarkModeSupport: true,
    osxSign: {},
    extraResource: [
      // Bundle the plugin source so the packaged app can find it
      '../index.ts',
      '../src',
      '../skills',
      '../openclaw.plugin.json',
      '../package.json',
      '../node_modules',
    ],
  },
  makers: [
    { name: '@electron-forge/maker-dmg', config: {} },
    { name: '@electron-forge/maker-zip', config: {}, platforms: ['darwin'] },
  ],
};

export default config;
