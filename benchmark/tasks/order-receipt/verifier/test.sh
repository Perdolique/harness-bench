#!/bin/sh
set -eu

exec node --experimental-strip-types /opt/verifier/container-verifier.mjs
