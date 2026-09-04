FROM node:26.8.1-bookworm-slim@sha256:f105cb6a6b56d32ea0295fcd100e4f06afa29ac51396315497f37eb9dc2b2848

ARG GIT_VERSION=1:2.39.5-0+deb12u3
ARG CA_CERTIFICATES_VERSION=20250419~deb12u1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates="${CA_CERTIFICATES_VERSION}" \
      git="${GIT_VERSION}" \
    && npm install --global --ignore-scripts=false @openai/codex@0.153.2 \
    && codex --version \
    && rm -rf /var/lib/apt/lists/*

COPY fixture/base/ /app/

RUN npm --prefix /app test

WORKDIR /app
