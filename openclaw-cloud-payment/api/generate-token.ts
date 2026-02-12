import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

// 简单的 JWT 实现（生产环境建议使用 jsonwebtoken 库）
function createToken(payload: any, secret: string, expiresIn: number = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const data = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
  };

  const payloadStr = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payloadStr}`)
    .digest('base64url');

  return `${header}.${payloadStr}.${signature}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user_id, username } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // 生成 token（1 小时有效期）
    const token = createToken(
      { user_id, username },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      3600
    );

    const subscribeUrl = `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/subscribe?token=${token}`;

    res.status(200).json({
      token,
      url: subscribeUrl
    });
  } catch (error: any) {
    console.error('Generate token error:', error);
    res.status(500).json({ error: error.message });
  }
}
