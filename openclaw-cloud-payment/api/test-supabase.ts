import { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 测试 Supabase 连接
    const testResult = await db.getSubscriptionByTelegramId('test_user_123');

    res.status(200).json({
      status: 'ok',
      message: 'Supabase connection successful',
      result: testResult,
      env: {
        supabase_url: process.env.SUPABASE_URL ? '✓' : '✗',
        supabase_service_key: process.env.SUPABASE_SERVICE_KEY ? '✓' : '✗',
        key_length: process.env.SUPABASE_SERVICE_KEY?.length || 0,
        key_prefix: process.env.SUPABASE_SERVICE_KEY?.substring(0, 10) || 'none',
      }
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      stack: error.stack,
      env: {
        supabase_url: process.env.SUPABASE_URL ? '✓' : '✗',
        supabase_service_key: process.env.SUPABASE_SERVICE_KEY ? '✓' : '✗',
        key_length: process.env.SUPABASE_SERVICE_KEY?.length || 0,
        key_prefix: process.env.SUPABASE_SERVICE_KEY?.substring(0, 10) || 'none',
      }
    });
  }
}
