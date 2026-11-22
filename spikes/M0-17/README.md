# M0-17 prototype: Codex headless

Throwaway spike code for [M0-17](https://github.com/jcore9/Aphelion/issues/113). This branch is never merged. The finding is `docs/spikes/M0-17-codex-headless.md` on `dev`.

## What is here

- `checks/app-server-probe.ts` drives `codex app-server` over stdio JSON-RPC, answers every approval request, and logs each item.
- `checks/acp-probe.ts` drives any ACP agent. It is the M0-03 probe, used here for `codex-acp`.
- `checks/mock_responses.py` is a scripted stand-in for the Responses API. It lets the approval tests run with no login and no plan usage.
- `checks/matrix.sh` runs one scripted turn (`scripts/s-matrix.json`) and prints, per tool call, whether an approval request came first.
- `docker/` holds the hardened test image, three root-owned `/etc/codex` variants, and the scripts that run inside the container.
- `runs/` holds the logs behind every number in the finding. `r1-appserver-untrusted.jsonl` is the only turn on the owner's ChatGPT login. Account ids and the email are redacted.

## Run the approval matrix on the host

1. Start the mock: `python3 -I checks/mock_responses.py 18080 /tmp/script.json /tmp/mock.jsonl`.
2. Point a scratch `CODEX_HOME` at it with a `model_providers.mock` entry (`base_url = "http://127.0.0.1:18080/v1"`, `env_key = "MOCK_KEY"`).
3. Run `WS=/tmp/ws OUT=/tmp/out MOCK_DIR=/tmp CODEX_BIN=/path/to/codex checks/matrix.sh untrusted scripts/s-matrix.json --prompt go --policy '"untrusted"' --sandbox workspace-write`.

Never point these scripts at a real `~/.codex`.

## Run the container checks

Build `docker/Dockerfile` with the Codex 0.169.0 `vendor/x86_64-unknown-linux-musl` folder as `codex-0169` and a `bun` binary in the context. Then build `Dockerfile.req*` on top. Mount a folder with `checks/*`, `docker/container/*`, `scripts/s-matrix.json`, the `codex-acp` bundles (`codex-acp-270/index.js`, `codex-acp-290/index.js`) and `node_modules/@agentclientprotocol/sdk` at `/opt/spike`, and run a script from `docker/container/` with `--read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10001:10001`.
