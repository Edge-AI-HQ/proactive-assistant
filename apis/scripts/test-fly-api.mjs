#!/usr/bin/env node
/**
 * 独立测试 Fly Machines API（不依赖项目构建）
 * 用于快速排查：Fly 凭证、Volume、Machine 创建是否正常
 *
 * 用法：
 *   cd apis && node scripts/test-fly-api.mjs
 *
 * 环境变量：FLY_API_TOKEN, FLY_APP_NAME（或从 .env 加载）
 */

import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apisRoot = resolve(__dirname, '..');
const repoRoot = resolve(apisRoot, '..');
for (const p of [
  resolve(repoRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(apisRoot, '.env'),
  resolve(apisRoot, '.env.local')
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: false });
    break;
  }
}

const FLY_API_TOKEN = (process.env.FLY_API_TOKEN || '').trim();
const FLY_APP_NAME = (process.env.FLY_APP_NAME || 'pinclaw-api-dev').trim();
const FLY_REGION = (process.env.FLY_REGION || 'iad').trim();
const OPENCLAW_IMAGE = (process.env.OPENCLAW_IMAGE || '').trim();
const API_BASE = 'https://api.machines.dev/v1';

async function flyRequest(method, path, body) {
  const url = `${API_BASE}/apps/${encodeURIComponent(FLY_APP_NAME)}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${FLY_API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fly API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log('--- Fly API 独立测试 ---\n');
  console.log('FLY_APP_NAME:', FLY_APP_NAME);
  console.log('FLY_REGION:', FLY_REGION);
  console.log('FLY_API_TOKEN:', FLY_API_TOKEN ? '✓ 已设置' : '✗ 未设置');
  console.log('OPENCLAW_IMAGE:', OPENCLAW_IMAGE || '(未设置)');

  if (!FLY_API_TOKEN) {
    console.error('\n❌ 请设置 FLY_API_TOKEN');
    process.exit(1);
  }

  try {
    // Step 1: 列出 machines
    console.log('\n[1] GET /machines ...');
    const machines = await flyRequest('GET', '/machines');
    console.log(`    共 ${Array.isArray(machines) ? machines.length : 0} 台 machine`);

    // Step 2: 列出 volumes
    console.log('\n[2] GET /volumes ...');
    const volumes = await flyRequest('GET', '/volumes');
    console.log(`    共 ${Array.isArray(volumes) ? volumes.length : 0} 个 volume`);

    // Step 3: 检查 OPENCLAW_IMAGE 格式（Fly 需要 digest）
    if (OPENCLAW_IMAGE) {
      console.log('\n[3] 检查 OPENCLAW_IMAGE 格式 ...');
      if (!OPENCLAW_IMAGE.includes('@sha256:')) {
        console.error('    ✗ Fly 模式需要 digest 格式，例如: registry.fly.io/<app>@sha256:<64位hex>');
      } else {
        console.log('    ✓ 格式正确');
      }
    } else {
      console.log('\n[3] OPENCLAW_IMAGE 未设置，跳过格式检查');
    }

    // Step 4: 创建测试 volume（可选，用于验证 create 权限）
    const testVolumeName = `pinclaw_test_${Date.now().toString(36)}`.slice(0, 30);
    console.log(`\n[4] POST /volumes (name=${testVolumeName}) ...`);
    const createdVolume = await flyRequest('POST', '/volumes', {
      name: testVolumeName,
      region: FLY_REGION,
      size_gb: 1
    });
    console.log('    ✓ Volume 创建成功:', createdVolume?.id || createdVolume?.name);

    // Step 5: 创建测试 machine（需要有效的 OPENCLAW_IMAGE）
    if (!OPENCLAW_IMAGE || !OPENCLAW_IMAGE.includes('@sha256:')) {
      console.log('\n[5] 跳过 machine 创建（需设置 digest 格式的 OPENCLAW_IMAGE）');
      console.log('\n✅ Fly API 基本测试通过');
      return;
    }

    const testMachineName = `pinclaw-test-${Date.now().toString(36)}`;
    const minimalInit = 'echo ok && sleep 5';
    console.log(`\n[5] POST /machines (name=${testMachineName}) ...`);
    const machineBody = {
      name: testMachineName,
      config: {
        image: OPENCLAW_IMAGE,
        env: {
          OPENCLAW_USER_ID: 'test',
          OPENCLAW_GATEWAY_PORT: '18789',
          OPENCLAW_CONFIG_PATH: '/app/data/config/openclaw.json',
          OPENCLAW_STATE_DIR: '/app/data'
        },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        mounts: [{ volume: createdVolume.id, path: '/app/data' }],
        restart: { policy: 'on-failure', max_retries: 1 },
        init: { exec: ['sh', '-c', minimalInit] }
      }
    };

    const createdMachine = await flyRequest('POST', '/machines', machineBody);
    console.log('    ✓ Machine 创建成功:', createdMachine?.id);

    // 清理：删除测试 machine 和 volume
    console.log('\n[6] 清理测试资源 ...');
    try {
      await flyRequest('DELETE', `/machines/${createdMachine.id}?force=true`);
      console.log('    ✓ 已删除测试 machine');
    } catch (e) {
      console.log('    删除 machine 失败（可忽略）:', e.message);
    }
    // Volume 无法通过 API 直接删除，保留即可

    console.log('\n✅ Fly API 完整测试通过');
  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
