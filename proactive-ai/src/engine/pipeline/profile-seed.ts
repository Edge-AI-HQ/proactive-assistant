import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getDefaultProfile, createDefaultProfile, upsertGoal } from './data-access.js';

export async function ensureDefaultProfile(api: OpenClawPluginApi): Promise<void> {
  const existing = await getDefaultProfile();
  if (existing) return;

  api.logger.info('Seeding default profile');

  await createDefaultProfile({
    displayName: 'User',
    locale: 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    summary: 'A busy professional balancing career, health, finances, and personal growth. Uses Proactive AI to stay on top of decisions and opportunities.',
  });

  const starterGoals = [
    { key: 'career-growth', title: 'Advance career and professional skills', priority: 'high' },
    { key: 'stay-healthy', title: 'Maintain consistent exercise and healthy habits', priority: 'medium' },
    { key: 'financial-plan', title: 'Grow savings and make smart financial decisions', priority: 'medium' },
    { key: 'learn-and-grow', title: 'Dedicate time to learning new skills and ideas', priority: 'medium' },
    { key: 'relationships', title: 'Stay connected with family and close friends', priority: 'medium' },
    { key: 'life-balance', title: 'Protect personal time and avoid burnout', priority: 'high' },
  ];

  for (const g of starterGoals) {
    await upsertGoal(g);
  }

  api.logger.info('Default profile seeded with 6 starter goals');
}
