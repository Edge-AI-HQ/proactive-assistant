FROM docker.litellm.ai/berriai/litellm:main-v1.82.0.dev1
WORKDIR /app

# Install dotenvx for runtime secret decryption
# LiteLLM base image is Alpine-based, use apk
RUN apk add --no-cache curl && curl -sfS https://dotenvx.sh/install.sh | sh && apk del curl

COPY litellm_config.yaml config.yaml

# Copy encrypted .env files (decrypted at runtime via DOTENV_PRIVATE_KEY_*)
COPY .env.dev .env.production ./

EXPOSE 4000

# DEPLOY_ENV selects which .env file to decrypt at startup (dev or production).
ARG DEPLOY_ENV=dev
ENV DEPLOY_ENV=${DEPLOY_ENV}

# 必须覆盖 ENTRYPOINT，否则 prod_entrypoint.sh 会忽略 --host 参数
# exec ensures litellm is PID 1 and receives SIGTERM for graceful shutdown
ENTRYPOINT ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} --overload -- litellm \"$@\"", "--"]
# 单进程模式：通过 Fly.io 水平扩展提高吞吐量
CMD ["--host", "0.0.0.0", "--port", "4000", "--config", "/app/config.yaml"]
