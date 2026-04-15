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

# Clear base image ENTRYPOINT (prod_entrypoint.sh ignores --host).
ENTRYPOINT []
# LiteLLM auto-runs Prisma migration on startup — no need for release_command.
CMD ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} -- litellm --host 0.0.0.0 --port 4000 --config /app/config.yaml"]
