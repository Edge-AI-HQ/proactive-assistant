# PIN AI OpenClaw 镜像构建

此目录用于构建自定义 OpenClaw 镜像并推送到 Fly.io registry。

## 架构说明

- **此目录不部署独立服务**：`pinai-openclaw` 只用于构建镜像，推送到 Fly registry
- **实际运行容器**：由 `pinclaw-api-dev/prod` 通过 `FLY_ASSISTANT_APP_NAME` 动态创建 assistant machines
- **镜像引用**：APIs 通过 `OPENCLAW_IMAGE` secret 引用 digest 格式的镜像

## 目录结构

```
pinai-openclaw/
├── fly.dev.toml          # Dev 环境镜像构建配置
├── fly.prod.toml         # Prod 环境镜像构建配置
├── image/
│   ├── Dockerfile        # OpenClaw 自定义镜像
│   ├── pinai-entrypoint.sh
│   ├── warmup-config.json
│   ├── scripts/
│   └── skills/
├── plugins/
│   ├── telegram-api-proxy/
│   ├── litellm-vision-adapter/
│   └── platform-hooks/
└── external/
    └── openclaw/         # OpenClaw 上游源码（只读，git submodule）
```

## 构建镜像

### 开发环境

```bash
./scripts/build-openclaw-image.sh dev
```

这将：
1. 使用 `pinai-openclaw/fly.dev.toml` 配置
2. 构建镜像并推送到 `registry.fly.io/pinclaw-openclaw-dev`
3. 输出 digest 格式的镜像引用

### 生产环境

```bash
./scripts/build-openclaw-image.sh prod
```

这将：
1. 使用 `pinai-openclaw/fly.prod.toml` 配置
2. 构建镜像并推送到 `registry.fly.io/pinclaw-openclaw-prod`
3. 输出 digest 格式的镜像引用

## 更新 APIs 镜像引用

构建完成后，脚本会输出类似：

```
✅ OpenClaw image digest:

  registry.fly.io/pinclaw-openclaw-dev@sha256:abc123...

Set OPENCLAW_IMAGE with:

  flyctl secrets set OPENCLAW_IMAGE="registry.fly.io/pinclaw-openclaw-dev@sha256:abc123..." -a pinclaw-api-dev
```

**重要**：
- 必须使用 `@sha256:` digest 格式，禁止使用 tag（会导致 crash loop）
- 更新 `OPENCLAW_IMAGE` 后，下次创建 assistant machine 时会使用新镜像
- 已运行的 assistant machines 不会自动更新，需要重建

## 插件开发

修改 `plugins/` 下的任何插件后：

1. 重新构建镜像（上述步骤）
2. 更新 `OPENCLAW_IMAGE` secret
3. 重建相关 assistant machines

**注意**：插件改动不会随 APIs 部署自动生效，必须走镜像 digest 更新流程。

## Fly Apps 说明

| App Name | 用途 | 是否运行容器 |
|----------|------|--------------|
| `pinclaw-openclaw-dev` | Dev 镜像构建和 registry | ❌ 否（仅 registry） |
| `pinclaw-openclaw-prod` | Prod 镜像构建和 registry | ❌ 否（仅 registry） |
| `pinclaw-api-dev` | Dev APIs 服务 | ✅ 是 |
| `pinclaw-api-prod` | Prod APIs 服务 | ✅ 是 |
| `pinclaw-assistant-dev` | Dev OpenClaw machines | ✅ 是（动态创建） |
| `pinclaw-assistant-prod` | Prod OpenClaw machines | ✅ 是（动态创建） |

## 相关文档

- OpenClaw 上游文档：`external/openclaw/`
- 平台系统指引：`image/platform-system-guidance.md`
- 仓库规则：`../AGENTS.md`
