#!/bin/sh
set -eu

/usr/bin/tee "$@"

if [ "${FAKE_CODEX_MODE:-success}" = "fail" ]; then
  exit 23
fi
