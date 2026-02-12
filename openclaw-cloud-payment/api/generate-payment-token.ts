import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user_id, username } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // 生成随机 token（32 字节 = 64 个十六进制字符）
    const token = crypto.randomBytes(32).toString('hex');

    // Token 有效期 1 小时
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // 保存到数据库
    const { error } = await supabase.from('payment_sessions').insert({
      token,
      telegram_user_id: user_id,
      telegram_username: username,
      expires_at: expiresAt.toISOString(),
    });

    if (error) {
      throw error;
    }

    const subscribeUrl = `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/subscribe?token=${token}`;

    res.status(200).json({
      token,
      url: subscribeUrl,
      expires_at: expiresAt.toISOString(),
    });
  } catch (error: any) {
    console.error('Generate payment token error:', error);
    res.status(500).json({ error: error.message });
  }
}
