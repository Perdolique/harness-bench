#!/bin/sh
set -eu

exec node --experimental-strip-types /opt/spike/container-verifier.ts
