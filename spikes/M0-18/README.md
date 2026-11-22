# M0-18 prototype: per-bot isolation with user namespaces

Throwaway spike code for [M0-18](https://github.com/jcore9/Aphelion/issues/124). This branch is never merged. The finding is `docs/spikes/M0-18-namespaces.md` on `dev`.

## What is here

- `docker/Dockerfile` is the test image: `ubuntu:26.04` with `bubblewrap`, `socat`, `python3`, `curl`, and the `harness` (10000) and `aphelion-agent` (10001) users.
- `seccomp/docker-29.10.0-default.json` is Docker's built-in profile at Docker 29.10.0 (moby tag `docker-v29.10.0`, vendored `github.com/moby/profiles/seccomp` v0.3.0). `docker-29.10.0-apparmor-template.go.txt` is the matching AppArmor template.
- `seccomp/make-profiles.py` writes the variants (`userns-*.json`) from the default. `userns-nosetns.json` is the one the finding recommends.
- `checks/run.sh` starts the 0016-hardened container (`--read-only`, `--cap-drop ALL`, `--cap-add SETUID --cap-add SETGID`, `no-new-privileges`) as root and drops to `aphelion-agent` with `setpriv`, the way the init starts the agent runner.
- `checks/botwrap.sh` is what the runner would run to start one bot in its own namespaces.
- `checks/q*.sh` are the checks, one per question. `checks/mock_anthropic.py` stands in for the Messages API so Claude Code runs one Bash call with a dummy key. `checks/connect_proxy.py` is the M0-17 logging proxy.
- `runs/` holds the output behind every result in the finding.

## Run a check

1. `python3 -I seccomp/make-profiles.py seccomp`
2. `docker build -t aphelion-m018:base docker/`
3. `checks/run.sh <default|unconfined|userns-…> <check script> [docker args] -- [script args]`, for example `checks/run.sh userns-nosetns q5-isolation.sh --security-opt systempaths=unconfined -- fresh`.

The CLI checks mount the installed CLI packages read-only at `/opt/cli/{claude,codex,grok}`. Never mount a real `~/.claude`, `~/.codex` or `~/.grok`.
