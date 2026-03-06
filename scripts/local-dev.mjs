#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

export const REQUIRED_ENV_KEYS = [
  'SUPABASE_DB_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_ROUTER_WEBHOOK_URL',
  'ANTHROPIC_API_KEY'
];

const DEFAULT_API_HEALTH_URL = 'http://127.0.0.1:3000/health';
const DEFAULT_POSTGRES_CONTAINER = 'pinai-postgres-local';
const DEFAULT_TEMPLATE_PATH = path.join(os.homedir(), '.config', 'pinai', 'repos', 'pin-ai-assistant.env');

export function createContext(overrides = {}) {
  const repoRoot = overrides.repoRoot || process.cwd();
  const dataDir = overrides.dataDir || path.join(repoRoot, 'data', 'local-dev');
  return {
    repoRoot,
    envPath: overrides.envPath || path.join(repoRoot, '.env.local'),
    templatePath: overrides.templatePath || DEFAULT_TEMPLATE_PATH,
    dataDir,
    statePath: overrides.statePath || path.join(dataDir, 'state.json'),
    apisLogPath: overrides.apisLogPath || path.join(dataDir, 'apis.log'),
    ngrokLogPath: overrides.ngrokLogPath || path.join(dataDir, 'ngrok.log'),
    apiHealthUrl: overrides.apiHealthUrl || DEFAULT_API_HEALTH_URL,
    postgresContainerName: overrides.postgresContainerName || DEFAULT_POSTGRES_CONTAINER,
    runCheck: overrides.runCheck || runCheck,
    spawnDetached: overrides.spawnDetached || spawnDetached,
    killProcess: overrides.killProcess || process.kill,
    sleep: overrides.sleep || sleep,
    now: overrides.now || (() => Date.now()),
    stdout: overrides.stdout || process.stdout,
    stderr: overrides.stderr || process.stderr
  };
}

export function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const result = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

export function readEffectiveRepoEnv(context) {
  const baseEnvPath = path.join(context.repoRoot, '.env');
  return {
    ...readEnvFile(baseEnvPath),
    ...Object.fromEntries(
      Object.entries(readEnvFile(context.envPath)).filter(([key]) => !readEnvFile(baseEnvPath)[key])
    )
  };
}

export function resolveApiHealthUrl(env) {
  const port = resolveApiPort(env);
  return `http://127.0.0.1:${port}/health`;
}

export function resolveApiPort(env) {
  return env.PORT || '3000';
}

export function resolveNgrokHealthUrl(webhookUrl) {
  if (!webhookUrl || !webhookUrl.includes('ngrok')) return null;
  const baseUrl = webhookUrl.replace(/\/webhook\/telegram\/?$/, '').replace(/\/+$/, '');
  return `${baseUrl}/health`;
}

export function resolveBotUrl(botUsername) {
  if (!botUsername) return null;
  return `https://t.me/${botUsername.replace(/^@/, '')}`;
}

function hasLocalDependencies(context) {
  return fs.existsSync(path.join(context.repoRoot, 'node_modules', '.bin', 'tsx'));
}

export function collectDoctorProblems(context, env) {
  const problems = [];
  const baseEnv = readEnvFile(path.join(context.repoRoot, '.env'));
  const effectiveEnv = readEffectiveRepoEnv(context);
  const apiHealthUrl = resolveApiHealthUrl(effectiveEnv);
  const apiPort = resolveApiPort(effectiveEnv);

  if (!fs.existsSync(context.envPath)) {
    problems.push(`Missing repo env file: ${context.envPath}`);
  }

  for (const key of REQUIRED_ENV_KEYS) {
    if (!env[key]) problems.push(`Missing env key in .env.local: ${key}`);
  }

  if (baseEnv.PORT && env.PORT && baseEnv.PORT !== env.PORT) {
    problems.push(`PORT conflict: .env has ${baseEnv.PORT} but .env.local has ${env.PORT}; current app load order uses .env`);
  }

  if (!hasLocalDependencies(context)) {
    problems.push('dependencies are not installed; run `npm install`');
  }

  const ngrok = context.runCheck('pgrep', ['-f', `ngrok http ${apiPort}`]);
  if (!ngrok.ok) {
    problems.push(`ngrok is not running with \`ngrok http ${apiPort}\``);
  }

  const docker = context.runCheck('docker', ['info']);
  if (!docker.ok) {
    problems.push('docker is not available');
  }

  const pg = context.runCheck('docker', ['ps', '--format', '{{.Names}}']);
  if (!pg.ok || !pg.stdout.split('\n').includes(context.postgresContainerName)) {
    problems.push(`local postgres container \`${context.postgresContainerName}\` is not running`);
  }

  const health = context.runCheck('curl', ['-sf', apiHealthUrl]);
  if (!health.ok) {
    problems.push(`local APIs health check failed: ${apiHealthUrl}`);
  }

  const ngrokHealthUrl = resolveNgrokHealthUrl(env.TELEGRAM_ROUTER_WEBHOOK_URL || '');
  if (ngrokHealthUrl) {
    const ngrokHealth = context.runCheck('curl', ['-skf', ngrokHealthUrl]);
    if (!ngrokHealth.ok) {
      problems.push(`ngrok health check failed: ${ngrokHealthUrl}`);
    }
  }

  return problems;
}

export function loadState(context) {
  if (!fs.existsSync(context.statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(context.statePath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(context, state) {
  fs.mkdirSync(path.dirname(context.statePath), { recursive: true });
  fs.writeFileSync(context.statePath, JSON.stringify(state, null, 2));
}

function runCheck(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || ''
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTemplateDir(context) {
  fs.mkdirSync(path.dirname(context.templatePath), { recursive: true });
}

function writeOut(context, message) {
  context.stdout.write(`${message}\n`);
}

function writeErr(context, message) {
  context.stderr.write(`${message}\n`);
}

function writeSection(context, title, lines, writer = writeOut) {
  writer(context, title);
  for (const line of lines) {
    writer(context, `- ${line}`);
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureLogDir(context) {
  fs.mkdirSync(context.dataDir, { recursive: true });
}

function openLogFile(filePath) {
  return fs.openSync(filePath, 'a');
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: options.stdio || 'ignore',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: options.shell || false
  });
  child.unref();
  return child;
}

export function clearPortListeners(context, port) {
  const listeners = context.runCheck('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  if (!listeners.ok || !listeners.stdout) return 0;

  let cleared = 0;
  for (const value of listeners.stdout.split('\n')) {
    const pid = Number.parseInt(value.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    context.killProcess(pid, 'SIGTERM');
    cleared += 1;
  }
  return cleared;
}

async function waitForHealth(context, url, timeoutMs, intervalMs = 1000) {
  const startedAt = context.now();
  while (context.now() - startedAt < timeoutMs) {
    const result = context.runCheck('curl', ['-sf', url]);
    if (result.ok) return true;
    await context.sleep(intervalMs);
  }
  return false;
}

function ensureEnvExists(context) {
  ensureTemplateDir(context);

  if (!fs.existsSync(context.templatePath)) {
    throw new Error(`Missing template: ${context.templatePath}`);
  }

  if (!fs.existsSync(context.envPath)) {
    fs.copyFileSync(context.templatePath, context.envPath);
    return 'created';
  }

  return 'skipped';
}

function ensurePostgres(context) {
  const result = context.runCheck('docker', ['ps', '-a', '--format', '{{.Names}}']);
  if (!result.ok) {
    throw new Error('docker is not available');
  }

  const containers = result.stdout.split('\n').filter(Boolean);
  if (!containers.includes(context.postgresContainerName)) {
    throw new Error(`Missing docker container: ${context.postgresContainerName}`);
  }

  const running = context.runCheck('docker', ['ps', '--format', '{{.Names}}']);
  if (running.ok && running.stdout.split('\n').includes(context.postgresContainerName)) {
    return 'running';
  }

  const start = context.runCheck('docker', ['start', context.postgresContainerName]);
  if (!start.ok) {
    throw new Error(`Failed to start docker container: ${context.postgresContainerName}`);
  }

  return 'started';
}

function ensureNgrokRunning(context) {
  const apiPort = resolveApiPort(readEffectiveRepoEnv(context));
  const existing = context.runCheck('pgrep', ['-f', `ngrok http ${apiPort}`]);
  if (existing.ok) return { status: 'running', pid: Number.parseInt(existing.stdout.split('\n')[0] || '0', 10) || null };

  ensureLogDir(context);
  const stdoutFd = openLogFile(context.ngrokLogPath);
  const child = context.spawnDetached('ngrok', ['http', apiPort], {
    stdio: ['ignore', stdoutFd, stdoutFd]
  });
  fs.closeSync(stdoutFd);
  return { status: 'started', pid: child.pid };
}

async function ensureApisRunning(context) {
  if (!hasLocalDependencies(context)) {
    throw new Error('Dependencies not installed: run `npm install`');
  }

  const effectiveEnv = readEffectiveRepoEnv(context);
  const apiHealthUrl = resolveApiHealthUrl(effectiveEnv);
  const apiPort = resolveApiPort(effectiveEnv);
  const cleared = clearPortListeners(context, apiPort);

  ensureLogDir(context);
  const stdoutFd = openLogFile(context.apisLogPath);
  const child = context.spawnDetached('npm', ['run', 'dev', '--workspace', '@pin-ai/apis'], {
    cwd: context.repoRoot,
    stdio: ['ignore', stdoutFd, stdoutFd]
  });
  fs.closeSync(stdoutFd);

  const ok = await waitForHealth(context, apiHealthUrl, 60000);
  if (!ok) {
    throw new Error(`APIs failed to become healthy within timeout: ${apiHealthUrl}`);
  }

  return { status: cleared > 0 ? 'restarted' : 'started', pid: child.pid };
}

function stopManagedProcess(pid) {
  if (!isPidRunning(pid)) return 'not-running';
  process.kill(pid, 'SIGTERM');
  return 'stopped';
}

export function initEnv(context = createContext()) {
  const result = ensureEnvExists(context);
  if (result === 'created') {
    writeOut(context, '[local:init-env] Ready');
    writeSection(context, 'Env', [
      `.env.local: created`,
      `target: ${context.envPath}`,
      `template: ${context.templatePath}`
    ]);
  } else {
    writeOut(context, '[local:init-env] Ready');
    writeSection(context, 'Env', [
      `.env.local: already exists`,
      `target: ${context.envPath}`,
      `template: ${context.templatePath}`
    ]);
  }
  return result;
}

export function doctor(context = createContext()) {
  const env = readEnvFile(context.envPath);
  const effectiveEnv = readEffectiveRepoEnv(context);
  const apiHealthUrl = resolveApiHealthUrl(effectiveEnv);
  const webhookUrl = env.TELEGRAM_ROUTER_WEBHOOK_URL || '(missing)';
  const botUsername = env.TELEGRAM_BOT_USERNAME ? `@${env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}` : '(missing)';
  const problems = collectDoctorProblems(context, env);

  if (problems.length) {
    writeErr(context, '[local:doctor] Issues Found');
    writeSection(context, 'Issues', problems, writeErr);
    writeSection(context, 'Run', ['npm install', 'npm run local:init-env', 'npm run local:up'], writeErr);
    throw new Error('doctor failed');
  }

  writeOut(context, '[local:doctor] Passed');
  writeSection(context, 'Env', [
    `.env.local: ok`,
    `template: ${context.templatePath}`,
    `bot: ${botUsername}`
  ]);
  writeSection(context, 'Services', [
    'docker: ok',
    'postgres: ok',
    'ngrok: ok',
    'apis: ok'
  ]);
  writeSection(context, 'URLs', [
    `local health: ${apiHealthUrl}`,
    `webhook: ${webhookUrl}`
  ]);
  return true;
}

export async function up(context = createContext()) {
  const envResult = ensureEnvExists(context);
  const env = readEnvFile(context.envPath);
  const apiHealthUrl = resolveApiHealthUrl(readEffectiveRepoEnv(context));
  const webhookUrl = env.TELEGRAM_ROUTER_WEBHOOK_URL || '(missing)';
  const botHandle = env.TELEGRAM_BOT_USERNAME ? `@${env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}` : '(missing)';
  const botUrl = resolveBotUrl(env.TELEGRAM_BOT_USERNAME) || '(missing)';
  const postgres = ensurePostgres(context);
  const ngrok = ensureNgrokRunning(context);
  const apis = await ensureApisRunning(context);

  const state = loadState(context);
  state.lastUpAt = new Date(context.now()).toISOString();
  state.apis = apis.pid ? { pid: apis.pid, managed: true } : state.apis || { managed: false };
  state.ngrok = ngrok.pid ? { pid: ngrok.pid, managed: ngrok.status === 'started' } : state.ngrok || { managed: false };
  saveState(context, state);

  writeOut(context, '[local:up] Ready');
  writeSection(context, 'Env', [
    `.env.local: ${envResult}`,
    `template: ${context.templatePath}`,
    `bot: ${botHandle}`
  ]);
  writeSection(context, 'Services', [
    `postgres: ${postgres}`,
    `ngrok: ${ngrok.status}`,
    `apis: ${apis.status}`
  ]);
  writeSection(context, 'URLs', [
    `local health: ${apiHealthUrl}`,
    `webhook: ${webhookUrl}`,
    `bot: ${botUrl}`
  ]);
  writeSection(context, 'Next', [
    'TG: /reset_account',
    'TG: /start',
    'TG: /create_claw_assistant',
    'TG: hi'
  ]);
}

export function down(context = createContext()) {
  const state = loadState(context);
  const apisStatus = state.apis?.managed ? stopManagedProcess(state.apis.pid) : 'not-managed';
  const ngrokStatus = state.ngrok?.managed ? stopManagedProcess(state.ngrok.pid) : 'not-managed';
  const nextState = {
    ...state,
    apis: state.apis ? { ...state.apis, stoppedAt: new Date(context.now()).toISOString() } : undefined,
    ngrok: state.ngrok ? { ...state.ngrok, stoppedAt: new Date(context.now()).toISOString() } : undefined
  };
  saveState(context, nextState);

  writeOut(context, '[local:down] Done');
  writeSection(context, 'Stopped', [
    `apis: ${apisStatus}`,
    `ngrok: ${ngrokStatus}`
  ]);
  writeSection(context, 'Kept', ['postgres: untouched']);
}

function printUsage(context) {
  writeOut(context, 'Usage: node scripts/local-dev.mjs <init-env|doctor|up|down>');
}

export async function main(argv = process.argv.slice(2), context = createContext()) {
  const command = argv[0];

  switch (command) {
    case 'init-env':
      initEnv(context);
      return;
    case 'doctor':
      doctor(context);
      return;
    case 'up':
      await up(context);
      return;
    case 'down':
      down(context);
      return;
    default:
      printUsage(context);
      process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const context = createContext();
    writeErr(context, error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
