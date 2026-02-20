import bcrypt from 'bcryptjs';
import os from 'node:os';
import type { Application, NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import {
  createAdminSession,
  deleteAdminSession,
  ensureAdminUser,
  getLiteLLMUsageOverview,
  getAdminByUsername,
  getAdminSession,
  getUsageOverview,
  getUserUsageTotals,
  getUserById,
  listAssistantsByOwnerTelegramId,
  listTokenUsageLedgerByUser,
  listRecentLogs,
  listUsers,
  listUsersWithUsage
} from '../db.js';
import { getUserContainerLogs, restartUserContainer, stopUserContainer } from '../modules/container/manager.js';
import { syncLiteLLMBilling } from '../modules/litellm/service.js';

const adminAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = req.cookies?.admin_session as string | undefined;
  if (!token) {
    res.redirect('/admin');
    return;
  }

  const session = await getAdminSession(token);
  if (!session) {
    res.clearCookie('admin_session');
    res.redirect('/admin');
    return;
  }

  req.adminSession = session;
  next();
};

const renderLogin = (res: Response, error: string | null): void => {
  res.render('admin/login', { error });
};

const bootstrapAdmin = async (): Promise<void> => {
  await ensureAdminUser(config.admin.username, config.admin.passwordHash);
};

const parseLoginBody = (body: unknown): { username: string; password: string } => {
  if (!body || typeof body !== 'object') {
    return { username: '', password: '' };
  }

  const record = body as Record<string, unknown>;
  return {
    username: typeof record.username === 'string' ? record.username : '',
    password: typeof record.password === 'string' ? record.password : ''
  };
};

export const registerAdminRoutes = (app: Application): void => {
  void bootstrapAdmin().catch((error: unknown) => {
    console.error('Failed to bootstrap admin user', error);
  });

  app.get('/admin', async (req: Request, res: Response) => {
    const token = req.cookies?.admin_session as string | undefined;
    const session = token ? await getAdminSession(token) : null;
    if (session) {
      res.redirect('/admin/dashboard');
      return;
    }

    renderLogin(res, null);
  });

  app.post('/admin/login', async (req: Request, res: Response) => {
    const { username, password } = parseLoginBody(req.body);
    const admin = await getAdminByUsername(username);
    if (!admin) {
      renderLogin(res, '用户名或密码错误');
      return;
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      renderLogin(res, '用户名或密码错误');
      return;
    }

    const { sessionToken } = await createAdminSession(admin.id, config.admin.sessionTtlHours);
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production'
    });

    res.redirect('/admin/dashboard');
  });

  app.post('/admin/logout', async (req: Request, res: Response) => {
    const token = req.cookies?.admin_session as string | undefined;
    if (token) {
      await deleteAdminSession(token);
    }

    res.clearCookie('admin_session');
    res.redirect('/admin');
  });

  app.get('/admin/dashboard', adminAuth, async (req: Request, res: Response) => {
    const users = await listUsersWithUsage();
    const running = users.filter((user) => user.container_status === 'running').length;
    const usage = await getUsageOverview();
    const litellm = await getLiteLLMUsageOverview();
    const activeUsageUsers = users
      .filter((user) => user.total_tokens > 0)
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 20);

    const litellmSyncMessage = typeof req.query.litellm_sync === 'string' ? req.query.litellm_sync.trim() : '';

    const stats = {
      totalUsers: users.length,
      runningContainers: running,
      usage,
      litellm,
      uptime: os.uptime(),
      loadAvg: os.loadavg().map((value) => value.toFixed(2)),
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      }
    };

    const admin = req.adminSession?.admin_username ?? config.admin.username;
    res.render('admin/dashboard', { stats, admin, activeUsageUsers, litellmSyncMessage });
  });

  app.post('/admin/litellm/sync', adminAuth, async (req: Request, res: Response) => {
    void req;
    try {
      const result = await syncLiteLLMBilling();
      const message = `LiteLLM sync completed: synced=${result.synced}, failed=${result.failed}`;
      res.redirect(`/admin/dashboard?litellm_sync=${encodeURIComponent(message)}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.redirect(`/admin/dashboard?litellm_sync=${encodeURIComponent(`LiteLLM sync failed: ${message}`)}`);
    }
  });

  app.get('/admin/users', adminAuth, async (req: Request, res: Response) => {
    void req;
    const users = await listUsersWithUsage();
    res.render('admin/users', { users });
  });

  app.get('/admin/users/:user_id', adminAuth, async (req: Request, res: Response) => {
    const user = await getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    const logs = await getUserContainerLogs(user);
    const usage = await getUserUsageTotals(user.telegram_user_id);
    const usageLogs = await listTokenUsageLedgerByUser(user.telegram_user_id, 100);
    const assistants = await listAssistantsByOwnerTelegramId(user.telegram_user_id);
    res.render('admin/user_detail', { user, logs, usage, usageLogs, assistants });
  });

  app.post('/admin/users/:user_id/restart', adminAuth, async (req: Request, res: Response) => {
    const user = await getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    await restartUserContainer(user);
    res.redirect(`/admin/users/${user.id}`);
  });

  app.post('/admin/users/:user_id/stop', adminAuth, async (req: Request, res: Response) => {
    const user = await getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    await stopUserContainer(user);
    res.redirect(`/admin/users/${user.id}`);
  });

  app.get('/admin/logs', adminAuth, async (req: Request, res: Response) => {
    void req;
    const logs = await listRecentLogs(100);
    res.render('admin/logs', { logs });
  });

  app.get('/admin/stats', adminAuth, async (req: Request, res: Response) => {
    void req;
    const users = await listUsers();
    const usage = await getUsageOverview();
    const litellm = await getLiteLLMUsageOverview();
    res.json({
      totalUsers: users.length,
      runningContainers: users.filter((user) => user.container_status === 'running').length,
      usage,
      litellm
    });
  });
};
