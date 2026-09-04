FROM gogost/gost:3.2.7-nightly.20260602@sha256:b78c2c1c495117cc9d75be775e4b3a5737b64d72c97ed66e99866aaabb1d3cb6

COPY gost.yaml allowlist.txt /opt/egress-sidecar/
COPY --chmod=755 entrypoint.sh /opt/egress-sidecar/entrypoint.sh
COPY --chmod=755 bin/network-policy /usr/local/bin/network-policy
