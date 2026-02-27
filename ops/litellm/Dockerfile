FROM docker.litellm.ai/berriai/litellm:main-stable
WORKDIR /app
COPY litellm_config.yaml config.yaml
EXPOSE 4000
# 必须覆盖 ENTRYPOINT，否则 prod_entrypoint.sh 会忽略 --host 参数
ENTRYPOINT ["litellm"]
CMD ["--host", "0.0.0.0", "--port", "4000", "--config", "/app/config.yaml", "--num_workers", "2"]
