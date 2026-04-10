import type { ForgeConfig } from '@electron-forge/shared-types';

const skipSign = process.env.SKIP_SIGN === '1';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Proactive AI',
    executableName: 'proactive-ai',
    appBundleId: 'ai.pin.proactive-ai',
    darwinDarkModeSupport: true,
    ...(!skipSign && {
      osxSign: {},
      osxNotarize: {
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    }),
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
