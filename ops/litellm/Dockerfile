# 固定版本避免自动更新导致 schema 不一致
# 使用具体的稳定版本而不是滚动标签 main-stable
# 更新版本前需要先同步数据库 schema（运行 sync-schema.sql）
FROM docker.litellm.ai/berriai/litellm:v1.81.12-stable
WORKDIR /app
COPY litellm_config.yaml config.yaml
EXPOSE 4000
# 必须覆盖 ENTRYPOINT，否则 prod_entrypoint.sh 会忽略 --host 参数
ENTRYPOINT ["litellm"]
# 单进程模式：避免 worker 崩溃，通过 Fly.io 水平扩展提高吞吐量
# Worker 进程在生产环境不稳定，建议使用单进程 + 多机器方式
CMD ["--host", "0.0.0.0", "--port", "4000", "--config", "/app/config.yaml"]
