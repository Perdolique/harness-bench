FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

COPY trusted-source/ /trusted/source/
COPY core/ /opt/core/
COPY collector/container-collector.ts /opt/collector/container-collector.ts

RUN chmod -R 0555 /opt/core /opt/collector \
    && chmod -R a-w /trusted/source

CMD ["tail", "-f", "/dev/null"]
