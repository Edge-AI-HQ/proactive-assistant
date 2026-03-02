#!/usr/bin/env node

/**
 * 动态选择 Fly.io 容量充足的区域
 * 
 * 根据 fly platform regions 的 CAPACITY 值，选择最佳的区域列表
 * 优先选择容量为正数且较大的区域，排除严重过载的区域
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * 从 fly platform regions 输出解析区域信息
 * @returns {Promise<Array<{name: string, code: string, capacity: number}>>}
 */
async function getRegionCapacity() {
  try {
    const { stdout } = await execAsync('fly platform regions');
    const lines = stdout.split('\n');
    const regions = [];

    for (const line of lines) {
      // 匹配格式：城市名称 \t 代码 \t 容量
      const match = line.match(/^(.+?)\s+([a-z]{3})\s+([-\d]+)\s*$/);
      if (match) {
        const [, name, code, capacityStr] = match;
        const capacity = parseInt(capacityStr, 10);
        if (!isNaN(capacity)) {
          regions.push({ name: name.trim(), code, capacity });
        }
      }
    }

    return regions;
  } catch (error) {
    console.error('获取区域容量失败:', error);
    return [];
  }
}

/**
 * 选择最佳区域列表
 * 
 * 策略：
 * 1. 优先选择容量 > 500 的区域（非常充足）
 * 2. 其次选择容量 > 100 的区域（充足）
 * 3. 最后选择容量 > 0 的区域（可用）
 * 4. 避免容量 < -1000 的严重过载区域
 * 5. 按容量从高到低排序
 * 6. 限制返回最多 8 个区域
 * 
 * @param {Array<{name: string, code: string, capacity: number}>} regions
 * @param {number} maxCount
 * @returns {Array<{name: string, code: string, capacity: number}>}
 */
function selectBestRegions(regions, maxCount = 8) {
  // 过滤掉严重过载的区域
  const available = regions.filter(r => r.capacity > -1000);
  
  // 按容量降序排序
  available.sort((a, b) => b.capacity - a.capacity);
  
  // 优先选择容量充足的区域
  const excellent = available.filter(r => r.capacity > 500);
  const good = available.filter(r => r.capacity > 100 && r.capacity <= 500);
  const ok = available.filter(r => r.capacity > 0 && r.capacity <= 100);
  const fallback = available.filter(r => r.capacity <= 0 && r.capacity > -1000);
  
  // 组合结果
  const selected = [...excellent, ...good, ...ok, ...fallback].slice(0, maxCount);
  
  return selected;
}

/**
 * 生成区域配置字符串
 * @param {Array<{name: string, code: string, capacity: number}>} regions
 * @returns {string}
 */
function generateRegionConfig(regions) {
  return regions.map(r => r.code).join(',');
}

/**
 * 打印区域信息表格
 * @param {Array<{name: string, code: string, capacity: number}>} regions
 */
function printRegions(regions) {
  console.log('\n选择的区域列表：');
  console.log('─'.repeat(60));
  console.log('排序 | 代码 | 容量   | 区域名称');
  console.log('─'.repeat(60));
  
  regions.forEach((region, index) => {
    const capacityStr = region.capacity.toString().padStart(6);
    const status = region.capacity > 500 ? '✓ 极佳' :
                   region.capacity > 100 ? '✓ 充足' :
                   region.capacity > 0   ? '○ 可用' :
                   '△ 备用';
    console.log(`${(index + 1).toString().padStart(2)} | ${region.code} | ${capacityStr} | ${region.name} ${status}`);
  });
  
  console.log('─'.repeat(60));
}

async function main() {
  console.log('正在获取 Fly.io 区域容量信息...');
  
  const regions = await getRegionCapacity();
  
  if (regions.length === 0) {
    console.error('❌ 无法获取区域信息');
    process.exit(1);
  }
  
  const selected = selectBestRegions(regions);
  
  if (selected.length === 0) {
    console.error('❌ 没有可用的区域');
    process.exit(1);
  }
  
  printRegions(selected);
  
  const config = generateRegionConfig(selected);
  
  console.log('\n推荐的环境变量配置：');
  console.log('─'.repeat(60));
  console.log(`FLY_REGION="${config}"`);
  console.log('─'.repeat(60));
  
  console.log('\n使用方法：');
  console.log('1. 将上述配置添加到 .env 文件');
  console.log('2. 或者通过 fly secrets set 设置：');
  console.log(`   fly secrets set FLY_REGION="${config}" -a pinclaw-api-dev`);
  console.log('\n注意：区域列表会在资源不足时按顺序尝试\n');
}

main().catch((error) => {
  console.error('执行失败:', error);
  process.exit(1);
});
