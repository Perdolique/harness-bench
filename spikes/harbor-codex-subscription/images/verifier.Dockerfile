FROM node:26.8.1-bookworm-slim@sha256:f105cb6a6b56d32ea0295fcd100e4f06afa29ac51396315497f37eb9dc2b2848

ARG GIT_VERSION=1:2.39.5-0+deb12u3

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      git="${GIT_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY fixture/base/ /trusted/base/
RUN git -C /trusted/base init --quiet \
    && git -C /trusted/base config user.email spike@example.invalid \
    && git -C /trusted/base config user.name "Spike Fixture" \
    && git -C /trusted/base add --all \
    && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
      git -C /trusted/base commit --quiet -m "fixture: initialize base"

COPY capture.ts constants.ts container-verifier.ts /opt/spike/
COPY fixture/hidden.test.mjs /tests/hidden.test.mjs
COPY images/verifier-test.sh /tests/test.sh
RUN chmod 0555 /tests/test.sh

WORKDIR /trusted/base
