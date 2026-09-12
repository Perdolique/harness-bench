#!/bin/sh
set -eu

if [ "${1:-}" = "--version" ]; then
  if [ "${FAKE_CODEX_MODE:-success}" = "fail" ]; then
    printf 'controlled codex version failure\n' >&2
    exit 23
  fi

  printf 'codex-cli 0.154.0\n'
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

auth_path="$CODEX_HOME/auth.json"

test -f "$auth_path"
test "$(cat "$auth_path")" = '{"fixture":"provider-free-fake-codex-auth"}'
test "$(stat -Lc '%U' "$auth_path")" = 'pwuser'
test "$(stat -Lc '%a' "$auth_path")" = '600'
test "$(id -u)" -ne 0

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
    session_dir="$CODEX_HOME/sessions/2026/09/06"
    session_path="$session_dir/rollout-2026-09-06T12-00-00-provider-free-fixture.jsonl"
    mkdir -p "$session_dir"
    printf '%s\n' \
      '{"type":"session_meta","payload":{"id":"provider-free-fixture","timestamp":"2026-09-06T12:00:00.000Z","cli_version":"0.154.0","originator":"codex_exec","source":"exec","model_provider":"openai"}}' \
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fixture complete"}]}}' \
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0}}}}' \
      > "$session_path"
    printf '{"type":"thread.started","thread_id":"provider-free-fixture"}\n'
    printf '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"fixture complete"}}\n'
    printf '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}\n'
    ;;
  *)
    printf 'unknown FAKE_CODEX_MODE\n' >&2
    exit 9
    ;;
esac
