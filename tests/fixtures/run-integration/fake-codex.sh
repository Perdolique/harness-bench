#!/bin/sh
set -eu

if [ "${1:-}" = "--version" ]; then
  if [ "${FAKE_CODEX_MODE:-success}" = "fail" ]; then
    printf 'controlled codex version failure\n' >&2
    exit 23
  fi

  printf 'codex-cli 0.153.2\n'
  exit 0
fi

if [ "${1:-}" = "--strict-config" ] && [ "${2:-}" = "doctor" ]; then
  printf '{"checks":{"config.load":{"status":"ok"}}}\n'
  exit 0
fi

if [ "${1:-}" = "exec" ] && [ "${2:-}" = "--strict-config" ]; then
  printf 'unknown configuration field zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control\n' >&2
  exit 2
fi

if [ "${1:-}" = "mcp" ]; then
  printf '[]\n'
  exit 0
fi

if [ "${1:-}" != "exec" ]; then
  printf 'unsupported fake codex command\n' >&2
  exit 9
fi

case "${FAKE_CODEX_MODE:-success}" in
  fail)
    printf '{"type":"error","message":"controlled agent failure"}\n'
    kill -TERM "$PPID"
    sleep 1
    exit 23
    ;;
  cancel)
    sleep 120
    ;;
  success)
    printf 'fixture-success\n' > RESULT.md
    printf '{"type":"thread.started","thread_id":"provider-free-fixture"}\n'
    printf '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"fixture complete"}}\n'
    printf '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}\n'
    ;;
  *)
    printf 'unknown FAKE_CODEX_MODE\n' >&2
    exit 9
    ;;
esac
