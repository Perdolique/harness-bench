FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

RUN npm install --global --allow-scripts=pnpm pnpm@12.4.1

COPY trusted-source/ /trusted/source/
COPY trusted-source/ /opt/task-runtime/
COPY core/ /opt/core/
COPY verifier/container-verifier.mjs /opt/verifier/container-verifier.mjs
COPY verifier/order-receipt.hidden.test.ts /tests-hidden/order-receipt.hidden.test.ts
COPY verifier/test.sh /tests/test.sh

RUN pnpm --dir /opt/task-runtime install --frozen-lockfile \
    && pnpm --dir /opt/task-runtime test \
    && pnpm --dir /opt/task-runtime build \
    && mkdir -p /opt/task-runtime/node_modules/.vite-temp \
      /opt/task-runtime/node_modules/.vite \
      /opt/task-runtime/node_modules/.vue-global-types \
    && chown -R pwuser:pwuser /opt/task-runtime/node_modules/.vite-temp \
      /opt/task-runtime/node_modules/.vite \
      /opt/task-runtime/node_modules/.vue-global-types \
    && chmod 0555 /tests/test.sh \
    && chmod -R 0700 /opt/verifier /tests-hidden \
    && chmod -R 0555 /opt/core \
    && chmod -R a-w /trusted/source \
    && chmod -R a+rX /opt/task-runtime/node_modules

WORKDIR /trusted/source
