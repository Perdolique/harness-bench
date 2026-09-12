FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

ARG TASK_BASE_COMMIT
ARG RIPGREP_VERSION=14.1.0-1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ripgrep="${RIPGREP_VERSION}" \
    && npm install --global --allow-scripts=pnpm pnpm@12.4.1 \
    && rm -rf /var/lib/apt/lists/*

COPY source/ /app/

RUN test "$(git -C /app rev-parse HEAD)" = "${TASK_BASE_COMMIT}" \
    && test "$(git -C /app rev-list --count --all)" = "1" \
    && test -z "$(git -C /app remote)" \
    && pnpm --dir /app install --frozen-lockfile \
    && pnpm --dir /app test \
    && pnpm --dir /app build \
    && chown -R pwuser:pwuser /app

USER pwuser
WORKDIR /app
