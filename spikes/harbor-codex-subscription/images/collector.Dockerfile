FROM node:26.8.1-bookworm-slim@sha256:f105cb6a6b56d32ea0295fcd100e4f06afa29ac51396315497f37eb9dc2b2848

ARG GIT_VERSION=1:2.39.5-0+deb12u3
ARG CA_CERTIFICATES_VERSION=20250419~deb12u1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates="${CA_CERTIFICATES_VERSION}" \
      git="${GIT_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY fixture/base/ /trusted/base/
RUN git -C /trusted/base init --quiet \
    && git -C /trusted/base config user.email spike@example.invalid \
    && git -C /trusted/base config user.name "Spike Fixture" \
    && git -C /trusted/base add --all \
    && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
      git -C /trusted/base commit --quiet -m "fixture: initialize base"

COPY capture.ts constants.ts container-collector.ts /opt/spike/
CMD ["tail", "-f", "/dev/null"]
