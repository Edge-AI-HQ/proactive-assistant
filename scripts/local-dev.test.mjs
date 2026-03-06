import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearPortListeners,
  collectDoctorProblems,
  createContext,
  doctor,
  down,
  initEnv,
  readEnvFile,
  readEffectiveRepoEnv,
  resolveApiHealthUrl,
  resolveBotUrl,
  resolveNgrokHealthUrl,
  up
} from './local-dev.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pinai-local-dev-'));
}

test('initEnv copies template into repo env when missing', () => {
  const tempDir = makeTempDir();
  const templatePath = path.join(tempDir, 'template.env');
  const envPath = path.join(tempDir, '.env.local');
  fs.writeFileSync(templatePath, 'SUPABASE_DB_URL=postgres://local\n');

  const output = [];
  const context = createContext({
    repoRoot: tempDir,
    templatePath,
    envPath,
    stdout: { write: (message) => output.push(message) },
    stderr: { write: () => {} }
  });

  const result = initEnv(context);

  assert.equal(result, 'created');
  assert.equal(readEnvFile(envPath).SUPABASE_DB_URL, 'postgres://local');
  assert.match(output.join(''), /\[local:init-env\] Ready/);
  assert.match(output.join(''), /Env/);
  assert.match(output.join(''), /\.env\.local: created/);
});

test('resolveNgrokHealthUrl derives /health from telegram webhook url', () => {
  const url = 'https://conceptacular-vernell-penal.ngrok-free.dev/webhook/telegram';
  assert.equal(resolveNgrokHealthUrl(url), 'https://conceptacular-vernell-penal.ngrok-free.dev/health');
});

test('resolveBotUrl derives Telegram bot profile url', () => {
  assert.equal(resolveBotUrl('@smile_gog_test_bot'), 'https://t.me/smile_gog_test_bot');
});

test('clearPortListeners terminates existing listener pids for the api port', () => {
  const killed = [];
  const context = createContext({
    repoRoot: makeTempDir(),
    runCheck: (cmd, args) => {
      if (cmd === 'lsof') {
        assert.deepEqual(args, ['-tiTCP:3001', '-sTCP:LISTEN']);
        return { ok: true, stdout: '111\n222', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: '' };
    },
    killProcess: (pid, signal) => killed.push({ pid, signal })
  });

  const cleared = clearPortListeners(context, '3001');

  assert.equal(cleared, 2);
  assert.deepEqual(killed, [
    { pid: 111, signal: 'SIGTERM' },
    { pid: 222, signal: 'SIGTERM' }
  ]);
});

test('readEffectiveRepoEnv preserves first-loaded .env values for overlapping keys', () => {
  const tempDir = makeTempDir();
  fs.writeFileSync(path.join(tempDir, '.env'), 'PORT=12000\n');
  fs.writeFileSync(path.join(tempDir, '.env.local'), 'PORT=3001\nTELEGRAM_BOT_TOKEN=token\n');

  const context = createContext({
    repoRoot: tempDir,
    envPath: path.join(tempDir, '.env.local')
  });

  const env = readEffectiveRepoEnv(context);

  assert.equal(env.PORT, '12000');
  assert.equal(env.TELEGRAM_BOT_TOKEN, 'token');
  assert.equal(resolveApiHealthUrl(env), 'http://127.0.0.1:12000/health');
});

test('collectDoctorProblems reports missing env keys and failed checks', () => {
  const tempDir = makeTempDir();
  const envPath = path.join(tempDir, '.env.local');
  fs.writeFileSync(path.join(tempDir, '.env'), 'PORT=12000\n');
  fs.writeFileSync(envPath, 'PORT=3001\nSUPABASE_DB_URL=postgres://local\n');

  const responses = new Map([
    ['pgrep -f ngrok http 3001', { ok: false, stdout: '', stderr: '' }],
    ['docker info', { ok: true, stdout: '', stderr: '' }],
    ['docker ps --format {{.Names}}', { ok: true, stdout: 'other-container', stderr: '' }],
    ['curl -sf http://127.0.0.1:3001/health', { ok: false, stdout: '', stderr: '' }]
  ]);

  const context = createContext({
    repoRoot: tempDir,
    envPath,
    runCheck: (cmd, args) => responses.get(`${cmd} ${args.join(' ')}`) || { ok: false, stdout: '', stderr: '' }
  });

  const problems = collectDoctorProblems(context, readEnvFile(envPath));

  assert.ok(problems.some((item) => item.includes('Missing env key in .env.local: TELEGRAM_BOT_TOKEN')));
  assert.ok(problems.some((item) => item.includes('PORT conflict: .env has 12000')));
  assert.ok(problems.some((item) => item.includes('dependencies are not installed')));
  assert.ok(problems.some((item) => item.includes('ngrok is not running')));
  assert.ok(problems.some((item) => item.includes('pinai-postgres-local')));
  assert.ok(problems.some((item) => item.includes('local APIs health check failed')));
});

test('doctor prints summary sections when checks pass', () => {
  const tempDir = makeTempDir();
  const envPath = path.join(tempDir, '.env.local');
  fs.writeFileSync(envPath, [
    'SUPABASE_DB_URL=postgres://local',
    'TELEGRAM_BOT_TOKEN=token',
    'TELEGRAM_WEBHOOK_SECRET=secret',
    'TELEGRAM_BOT_USERNAME=smile_gog_test_bot',
    'TELEGRAM_ROUTER_WEBHOOK_URL=https://conceptacular-vernell-penal.ngrok-free.dev/webhook/telegram',
    'ANTHROPIC_API_KEY=key'
  ].join('\n'));
  fs.mkdirSync(path.join(tempDir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'node_modules', '.bin', 'tsx'), '');

  const output = [];
  const responses = new Map([
    ['pgrep -f ngrok http 3000', { ok: true, stdout: '123', stderr: '' }],
    ['docker info', { ok: true, stdout: '', stderr: '' }],
    ['docker ps --format {{.Names}}', { ok: true, stdout: 'pinai-postgres-local', stderr: '' }],
    ['curl -sf http://127.0.0.1:3000/health', { ok: true, stdout: '', stderr: '' }],
    ['curl -skf https://conceptacular-vernell-penal.ngrok-free.dev/health', { ok: true, stdout: '', stderr: '' }]
  ]);

  const context = createContext({
    repoRoot: tempDir,
    envPath,
    runCheck: (cmd, args) => responses.get(`${cmd} ${args.join(' ')}`) || { ok: false, stdout: '', stderr: '' },
    stdout: { write: (message) => output.push(message) },
    stderr: { write: () => {} }
  });

  doctor(context);

  const text = output.join('');
  assert.match(text, /\[local:doctor\] Passed/);
  assert.match(text, /Env/);
  assert.match(text, /Services/);
  assert.match(text, /URLs/);
  assert.match(text, /bot: @smile_gog_test_bot/);
});

test('down prints summary sections', () => {
  const tempDir = makeTempDir();
  const dataDir = path.join(tempDir, 'data', 'local-dev');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    apis: { managed: false },
    ngrok: { managed: false }
  }));

  const output = [];
  const context = createContext({
    repoRoot: tempDir,
    dataDir,
    statePath: path.join(dataDir, 'state.json'),
    stdout: { write: (message) => output.push(message) },
    stderr: { write: () => {} }
  });

  down(context);

  const text = output.join('');
  assert.match(text, /\[local:down\] Done/);
  assert.match(text, /Stopped/);
  assert.match(text, /Kept/);
});

test('up prints bot url and next TG action', async () => {
  const tempDir = makeTempDir();
  const envPath = path.join(tempDir, '.env.local');
  fs.writeFileSync(envPath, [
    'PORT=3001',
    'SUPABASE_DB_URL=postgres://local',
    'TELEGRAM_BOT_TOKEN=token',
    'TELEGRAM_WEBHOOK_SECRET=secret',
    'TELEGRAM_BOT_USERNAME=smile_gog_test_bot',
    'TELEGRAM_ROUTER_WEBHOOK_URL=https://conceptacular-vernell-penal.ngrok-free.dev/webhook/telegram',
    'ANTHROPIC_API_KEY=key'
  ].join('\n'));
  fs.mkdirSync(path.join(tempDir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'node_modules', '.bin', 'tsx'), '');

  const output = [];
  const responses = new Map([
    ['docker ps -a --format {{.Names}}', { ok: true, stdout: 'pinai-postgres-local', stderr: '' }],
    ['docker ps --format {{.Names}}', { ok: true, stdout: 'pinai-postgres-local', stderr: '' }],
    ['pgrep -f ngrok http 3001', { ok: true, stdout: '123', stderr: '' }],
    ['curl -sf http://127.0.0.1:3001/health', { ok: true, stdout: '', stderr: '' }]
  ]);

  const context = createContext({
    repoRoot: tempDir,
    envPath,
    runCheck: (cmd, args) => responses.get(`${cmd} ${args.join(' ')}`) || { ok: false, stdout: '', stderr: '' },
    stdout: { write: (message) => output.push(message) },
    stderr: { write: () => {} },
    now: () => 1_700_000_000_000
  });

  await up(context);

  const text = output.join('');
  assert.match(text, /\[local:up\] Ready/);
  assert.match(text, /bot: https:\/\/t\.me\/smile_gog_test_bot/);
  assert.match(text, /TG: hi/);
});
