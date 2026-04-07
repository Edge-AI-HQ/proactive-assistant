import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { pinCli } from './pipeline/pin-cli.js';

export async function ensureDefaultProfile(api: OpenClawPluginApi): Promise<void> {
  const check = await pinCli('profile get --id default');
  if (check.ok) return;

  api.logger.info('Seeding default profile');

  await pinCli([
    'profile create',
    '--id default',
    '--display-name "User"',
    '--locale en-US',
    `--timezone "${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
    '--summary "A busy professional balancing career, health, finances, and personal growth. Uses Proactive AI to stay on top of decisions and opportunities."',
  ].join(' '));

  const starterGoals = [
    { key: 'career-growth', title: 'Advance career and professional skills', priority: 'high' },
    { key: 'stay-healthy', title: 'Maintain consistent exercise and healthy habits', priority: 'medium' },
    { key: 'financial-plan', title: 'Grow savings and make smart financial decisions', priority: 'medium' },
    { key: 'learn-and-grow', title: 'Dedicate time to learning new skills and ideas', priority: 'medium' },
    { key: 'relationships', title: 'Stay connected with family and close friends', priority: 'medium' },
    { key: 'life-balance', title: 'Protect personal time and avoid burnout', priority: 'high' },
  ];

  for (const g of starterGoals) {
    await pinCli(`profile goals upsert --key ${g.key} --title "${g.title}" --priority ${g.priority}`);
  }

  api.logger.info('Default profile seeded with 6 starter goals');
}
