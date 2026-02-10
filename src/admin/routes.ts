import bcrypt from 'bcryptjs';
import os from 'node:os';
import type { Application, NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import {
  createAdminSession,
  deleteAdminSession,
  ensureAdminUser,
  getAdminByUsername,
  getAdminSession,
  getUserById,
  listRecentLogs,
  listUsers
} from '../db.js';
import { getUserContainerLogs, restartUserContainer, stopUserContainer } from '../docker/manager.js';

const adminAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = req.cookies?.admin_session as string | undefined;
  if (!token) {
    res.redirect('/admin');
    return;
  }

  const session = getAdminSession(token);
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

const bootstrapAdmin = (): void => {
  ensureAdminUser(config.admin.username, config.admin.passwordHash);
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
  bootstrapAdmin();

  app.get('/admin', (req: Request, res: Response) => {
    const token = req.cookies?.admin_session as string | undefined;
    if (token && getAdminSession(token)) {
      res.redirect('/admin/dashboard');
      return;
    }

    renderLogin(res, null);
  });

  app.post('/admin/login', async (req: Request, res: Response) => {
    const { username, password } = parseLoginBody(req.body);
    const admin = getAdminByUsername(username);
    if (!admin) {
      renderLogin(res, '用户名或密码错误');
      return;
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      renderLogin(res, '用户名或密码错误');
      return;
    }

    const { sessionToken } = createAdminSession(admin.id, config.admin.sessionTtlHours);
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production'
    });

    res.redirect('/admin/dashboard');
  });

  app.post('/admin/logout', (req: Request, res: Response) => {
    const token = req.cookies?.admin_session as string | undefined;
    if (token) {
      deleteAdminSession(token);
    }

    res.clearCookie('admin_session');
    res.redirect('/admin');
  });

  app.get('/admin/dashboard', adminAuth, (req: Request, res: Response) => {
    const users = listUsers();
    const running = users.filter((user) => user.container_status === 'running').length;

    const stats = {
      totalUsers: users.length,
      runningContainers: running,
      uptime: os.uptime(),
      loadAvg: os.loadavg().map((value) => value.toFixed(2)),
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      }
    };

    const admin = req.adminSession?.admin_username ?? config.admin.username;
    res.render('admin/dashboard', { stats, admin });
  });

  app.get('/admin/users', adminAuth, (req: Request, res: Response) => {
    void req;
    const users = listUsers();
    res.render('admin/users', { users });
  });

  app.get('/admin/users/:user_id', adminAuth, async (req: Request, res: Response) => {
    const user = getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    const logs = await getUserContainerLogs(user);
    res.render('admin/user_detail', { user, logs });
  });

  app.post('/admin/users/:user_id/restart', adminAuth, async (req: Request, res: Response) => {
    const user = getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    await restartUserContainer(user);
    res.redirect(`/admin/users/${user.id}`);
  });

  app.post('/admin/users/:user_id/stop', adminAuth, async (req: Request, res: Response) => {
    const user = getUserById(Number(req.params.user_id));
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    await stopUserContainer(user);
    res.redirect(`/admin/users/${user.id}`);
  });

  app.get('/admin/logs', adminAuth, (req: Request, res: Response) => {
    void req;
    const logs = listRecentLogs(100);
    res.render('admin/logs', { logs });
  });

  app.get('/admin/stats', adminAuth, (req: Request, res: Response) => {
    void req;
    const users = listUsers();
    res.json({
      totalUsers: users.length,
      runningContainers: users.filter((user) => user.container_status === 'running').length
    });
  });
};
