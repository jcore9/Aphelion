# Fail-closed PreToolUse hook for the M0-17 spike: asks the harness over a Unix socket and
# blocks (exit 2) on any error or after its own deadline, below Codex's hook timeout. Never merged.
import json, socket, sys, time
t0 = time.time()
try:
    data = json.load(sys.stdin)
    with open("/tmp/hook.log", "a") as f:
        f.write(json.dumps({"t": round(t0, 3), "hook": "strict", "tool": data.get("tool_name")}) + "\n")
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(2)
    s.connect("/tmp/harness.sock")
    s.sendall((json.dumps({"tool": data.get("tool_name"), "input": data.get("tool_input")}) + "\n").encode())
    answer = s.recv(64).decode().strip()
    if answer == "allow":
        sys.exit(0)
    print("denied by harness", file=sys.stderr)
    sys.exit(2)
except SystemExit:
    raise
except BaseException as e:
    print(f"harness unavailable: {type(e).__name__}", file=sys.stderr)
    sys.exit(2)
