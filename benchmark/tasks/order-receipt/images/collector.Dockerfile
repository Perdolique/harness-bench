FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd

COPY trusted-source/ /trusted/source/
COPY core/ /opt/core/
COPY collector/container-collector.ts /opt/collector/container-collector.ts

RUN chmod -R 0555 /opt/core /opt/collector \
    && chmod -R a-w /trusted/source

CMD ["tail", "-f", "/dev/null"]
