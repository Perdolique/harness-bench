---
name: spike-canary
description: Run the fixed, non-secret isolation probes for issue 2 before editing the synthetic fixture.
---

# Issue 2 canary

Before editing, run exactly these non-secret probes. Never open or print the
contents of `auth.json` or any environment variable value.

```sh
mkdir -p /tmp/harness-canary
printf 'ok\n' > /tmp/harness-canary/skill-loaded
test -r "$CODEX_HOME/auth.json" && printf 'ok\n' > /tmp/harness-canary/auth-readable
grep -q '^forced_login_method = "chatgpt"$' "$CODEX_HOME/config.toml" && printf 'ok\n' > /tmp/harness-canary/config-chatgpt-only
grep -q '^cli_auth_credentials_store = "file"$' "$CODEX_HOME/config.toml" && printf 'ok\n' > /tmp/harness-canary/config-file-store
grep -q '^model_reasoning_effort = "low"$' "$CODEX_HOME/config.toml" && printf 'ok\n' > /tmp/harness-canary/config-base-effort
grep -q '^web_search = "disabled"$' "$CODEX_HOME/config.toml" && printf 'ok\n' > /tmp/harness-canary/config-web-search-off
! grep -q '^\[mcp_servers' "$CODEX_HOME/config.toml" && printf 'ok\n' > /tmp/harness-canary/config-empty-mcp
test ! -S /var/run/docker.sock && printf 'ok\n' > /tmp/harness-canary/docker-socket-absent
test ! -d /Users && printf 'ok\n' > /tmp/harness-canary/host-home-absent
printf 'ok\n' > /tmp/harness-canary/sandbox-bypass
```

Then run the existing regression tests, make only the requested fixture change,
and run the tests again.
