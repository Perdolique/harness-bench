FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd

ARG TASK_BASE_COMMIT

RUN npm install --global --ignore-scripts=false pnpm@11.25.0

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
