# Fly.io 区域选择脚本

## 问题背景

在 Fly.io 上创建 assistant 容器时，可能会遇到 "insufficient resources" 错误，特别是在热门区域（如 `iad`、`ord`、`dfw` 等美国东部/中部区域）。

## 解决方案

`select-fly-regions.mjs` 脚本会：

1. 动态查询所有 Fly.io 区域的当前容量
2. 选择容量充足的区域（优先选择容量 > 500 的区域）
3. 排除严重过载的区域（容量 < -1000）
4. 生成推荐的区域列表配置

## 使用方法

### 1. 运行脚本查看推荐区域

```bash
node scripts/select-fly-regions.mjs
```

输出示例：

```
选择的区域列表：
────────────────────────────────────────────────────────────
排序 | 代码 | 容量   | 区域名称
────────────────────────────────────────────────────────────
 1 | cdg |   1836 | Paris, France ✓ 极佳
 2 | gru |   1537 | Sao Paulo, Brazil ✓ 极佳
 3 | arn |    898 | Stockholm, Sweden ✓ 极佳
 4 | lhr |    800 | London, United Kingdom ✓ 极佳
 5 | yyz |    636 | Toronto, Canada ✓ 极佳
 6 | syd |    376 | Sydney, Australia ✓ 充足
 7 | jnb |    230 | Johannesburg, South Africa ✓ 充足
 8 | bom |    118 | Mumbai, India ✓ 充足
────────────────────────────────────────────────────────────

推荐的环境变量配置：
FLY_REGION="cdg,gru,arn,lhr,yyz,syd,jnb,bom"
```

### 2. 应用配置到 Fly.io

#### 方法 A：通过 fly secrets 设置（推荐）

```bash
fly secrets set FLY_REGION="cdg,gru,arn,lhr,yyz,syd,jnb,bom" -a pinclaw-api-dev
```

#### 方法 B：在 .env 文件中设置（本地测试）

```env
FLY_REGION=cdg,gru,arn,lhr,yyz,syd,jnb,bom
```

## 工作原理

当 API 尝试创建 assistant 容器时：

1. 首先尝试在第一个区域（cdg）创建
2. 如果遇到资源不足错误，自动尝试下一个区域（gru）
3. 重复直到成功或耗尽所有区域
4. 每个区域最多重试 8 次

相关代码：`apis/src/domain/container/providers/fly/assistant_machine.ts:290-357`

## 注意事项

1. **区域容量动态变化**：Fly.io 的区域容量会随时间变化，建议定期重新运行脚本更新配置
2. **延迟考虑**：优先选择的区域可能不是延迟最低的，如果对延迟敏感，可以手动调整区域顺序
3. **Volume 迁移**：切换区域后，现有的 volume 不会自动迁移，但代码会优先使用同区域的 volume
4. **多区域策略**：建议配置 5-8 个区域，提供足够的容错能力

## 常见区域代码

- **北美**：`iad`（Virginia）、`ord`（Chicago）、`dfw`（Dallas）、`yyz`（Toronto）
- **欧洲**：`cdg`（Paris）、`lhr`（London）、`arn`（Stockholm）、`fra`（Frankfurt）
- **亚太**：`sin`（Singapore）、`nrt`（Tokyo）、`syd`（Sydney）、`bom`（Mumbai）
- **南美**：`gru`（Sao Paulo）
- **非洲**：`jnb`（Johannesburg）

## 故障排查

### 问题：所有区域都资源不足

```bash
# 查看当前所有区域的容量状态
fly platform regions

# 等待几分钟后重试，或联系 Fly.io 支持
```

### 问题：容器创建在非预期区域

```bash
# 检查环境变量是否正确设置
fly secrets list -a pinclaw-api-dev | grep FLY_REGION

# 查看现有容器的区域
fly status -a pinclaw-api-dev
```

### 问题：脚本无法获取区域信息

```bash
# 检查 flyctl 是否已安装并登录
fly version
fly auth whoami

# 手动查看区域列表
fly platform regions
```

## 更新日志

- 2026-02-27：初始版本，支持自动选择容量充足的区域
