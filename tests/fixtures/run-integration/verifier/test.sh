#!/bin/sh
set -eu

exec node --experimental-strip-types /opt/verifier/verify.mjs
