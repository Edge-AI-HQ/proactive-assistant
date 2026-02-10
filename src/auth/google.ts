import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import type { Application, NextFunction, Request, Response } from 'express';
import type { Bot, Context } from 'grammy';
import { config } from '../config.js';
import {
  consumeOauthSession,
  createGatewayToken,
  createUser,
  getOauthSession,
  getUserByGoogleEmail,
  getUserByGoogleId,
  getUserByTelegramId,
  updateUser
} from '../db.js';
import { allocatePort, containerNameForUser, ensureUserContainer } from '../docker/manager.js';

interface AuthUserSuccess {
  email: string;
  googleId: string;
}

interface AuthUserError {
  error: 'forbidden_domain' | 'missing_email';
  email?: string;
}

type AuthUser = AuthUserSuccess | AuthUserError;

const isAuthUser = (value: unknown): value is AuthUser => {
  if (!value || typeof value !== 'object') return false;
  if ('error' in value) {
    const errorValue = (value as { error?: unknown }).error;
    return errorValue === 'forbidden_domain' || errorValue === 'missing_email';
  }
  const maybe = value as { email?: unknown; googleId?: unknown };
  return typeof maybe.email === 'string' && typeof maybe.googleId === 'string';
};

const isAllowedDomain = (email: string): boolean => email.toLowerCase().endsWith('@pinai.io');

const renderSimplePage = (res: Response, title: string, message: string): void => {
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:ui-sans-serif,system-ui;max-width:680px;margin:40px auto;padding:16px;">
  <h2>${title}</h2><p>${message}</p></body></html>`);
};

let strategyReady = false;

const ensurePassport = (): void => {
  if (strategyReady) return;

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
        passReqToCallback: true
      },
      async (
        req: Request,
        accessToken: string,
        refreshToken: string,
        profile: Profile,
        done: (error: unknown, user?: AuthUser | false) => void
      ): Promise<void> => {
        try {
          void req;
          void accessToken;
          void refreshToken;

          const email = profile.emails?.[0]?.value;
          if (!email) {
            done(null, { error: 'missing_email' });
            return;
          }

          if (!isAllowedDomain(email)) {
            done(null, { error: 'forbidden_domain', email });
            return;
          }

          done(null, { email, googleId: profile.id });
        } catch (error: unknown) {
          done(error);
        }
      }
    )
  );

  strategyReady = true;
};

export const registerAuthRoutes = (app: Application, bot?: Bot<Context>): void => {
  ensurePassport();

  app.use(passport.initialize());

  app.get('/auth/google', (req: Request, res: Response, next: NextFunction) => {
    const state = req.query.state;
    if (!state || typeof state !== 'string') {
      renderSimplePage(res, '登录失败', '缺少 state 参数，请从 Telegram 获取登录链接。');
      return;
    }

    const session = getOauthSession(state);
    if (!session) {
      renderSimplePage(res, '登录失败', '登录链接已过期，请回到 Telegram 重新发送 /start。');
      return;
    }

    passport.authenticate('google', {
      scope: ['profile', 'email'],
      state,
      session: false
    })(req, res, next);
  });

  app.get('/auth/google/callback', (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('google', { session: false }, async (err: unknown, rawUser: unknown) => {
      if (err) {
        console.error('Google auth error', err);
        renderSimplePage(res, '登录失败', '认证过程中出现错误，请稍后再试。');
        return;
      }

      if (!isAuthUser(rawUser)) {
        renderSimplePage(res, '登录失败', '认证失败，请稍后再试。');
        return;
      }

      if ('error' in rawUser) {
        if (rawUser.error === 'forbidden_domain') {
          renderSimplePage(res, '登录失败', '仅支持 @pinai.io 邮箱登录。');
          return;
        }

        if (rawUser.error === 'missing_email') {
          renderSimplePage(res, '登录失败', '未获取到邮箱信息，请检查 Google 账号设置。');
          return;
        }
      }

      const state = req.query.state;
      if (!state || typeof state !== 'string') {
        renderSimplePage(res, '登录失败', '缺少 state 参数。');
        return;
      }

      const session = consumeOauthSession(state);
      if (!session) {
        renderSimplePage(res, '登录失败', '登录链接已过期，请回到 Telegram 重新发送 /start。');
        return;
      }

      if ('error' in rawUser) {
        renderSimplePage(res, '登录失败', '认证失败，请稍后再试。');
        return;
      }

      const existingByGoogle = getUserByGoogleId(rawUser.googleId) || getUserByGoogleEmail(rawUser.email);
      if (existingByGoogle && existingByGoogle.telegram_user_id !== session.telegram_user_id) {
        renderSimplePage(res, '登录失败', '该 Google 账号已绑定其他 Telegram 用户。');
        return;
      }

      const existingByTelegram = getUserByTelegramId(session.telegram_user_id);
      let record = existingByTelegram;

      if (!record) {
        const containerPort = allocatePort();
        record = createUser({
          telegram_user_id: session.telegram_user_id,
          telegram_username: session.telegram_username,
          google_email: rawUser.email,
          google_id: rawUser.googleId,
          container_id: containerNameForUser(session.telegram_user_id),
          container_port: containerPort,
          container_status: 'creating',
          gateway_token: createGatewayToken()
        });
      } else {
        record = updateUser(session.telegram_user_id, {
          telegram_username: session.telegram_username || record.telegram_username,
          google_email: rawUser.email,
          google_id: rawUser.googleId
        });
      }

      if (!record) {
        renderSimplePage(res, '登录失败', '用户数据创建失败，请稍后重试。');
        return;
      }

      if (bot) {
        await bot.api.sendMessage(session.telegram_user_id, '登录成功！正在为您准备专属AI助手... ⏳');
      }

      try {
        const { ready } = await ensureUserContainer(record);
        if (bot) {
          if (ready) {
            await bot.api.sendMessage(session.telegram_user_id, '您的AI助手已就绪！现在可以开始对话了 ✅');
          } else {
            await bot.api.sendMessage(session.telegram_user_id, '容器启动失败，请联系管理员 ❌');
          }
        }
      } catch (error: unknown) {
        console.error('Container init error', error);
        if (bot) {
          await bot.api.sendMessage(session.telegram_user_id, '容器启动失败，请联系管理员 ❌');
        }
      }

      renderSimplePage(res, '登录成功', '您已成功登录，可以返回 Telegram 继续使用。');
    })(req, res, next);
  });
};
