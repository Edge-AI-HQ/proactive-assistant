# dotenvx (runtime secret decryption) is fetched in a throwaway stage. The
# litellm base is a pinned Wolfi snapshot on a rolling apk repo, so `apk add
# curl` inside it drifts into package conflicts (2026-11: openssl-4 libcrypto
# vs the image's openssl-3 owning /etc/ssl/openssl.cnf). The installer pulls the
# same linux release binary either way.
FROM alpine:3.20 AS dotenvx
RUN apk add --no-cache curl && curl -sfS https://dotenvx.sh/install.sh | sh

FROM docker.litellm.ai/berriai/litellm:v1.86.2
WORKDIR /app

COPY --from=dotenvx /usr/local/bin/dotenvx /usr/local/bin/dotenvx
RUN dotenvx --version

COPY litellm_config.yaml config.yaml

# Copy encrypted .env files (decrypted at runtime via DOTENV_PRIVATE_KEY_*)
COPY .env.dev .env.test .env.production ./

EXPOSE 4000

# DEPLOY_ENV selects which .env file to decrypt at startup (dev or production).
ARG DEPLOY_ENV=dev
ENV DEPLOY_ENV=${DEPLOY_ENV}

# Clear base image ENTRYPOINT (prod_entrypoint.sh ignores --host).
ENTRYPOINT []
# LiteLLM auto-runs Prisma migration on startup — no need for release_command.
CMD ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} -- litellm --host 0.0.0.0 --port 4000 --config /app/config.yaml"]
