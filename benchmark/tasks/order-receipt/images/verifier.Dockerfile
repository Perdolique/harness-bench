FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd

RUN npm install --global --ignore-scripts=false pnpm@11.25.0

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
