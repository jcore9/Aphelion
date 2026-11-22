# PreToolUse hook for the M0-17 spike. Logs the call, then behaves as /tmp/hook-mode says.
# Spike code. Never merged.
import json, sys, time
data = json.load(sys.stdin)
try:
    mode = open("/tmp/hook-mode").read().strip()
except OSError:
    mode = "allow"
with open("/tmp/hook.log", "a") as f:
    f.write(json.dumps({"mode": mode, "event": data.get("hook_event_name"), "tool": data.get("tool_name"), "input": str(data.get("tool_input"))[:80]}) + "\n")
if mode == "deny-exit2":
    print("blocked by policy", file=sys.stderr); sys.exit(2)
if mode == "deny-json":
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "blocked by policy"}})); sys.exit(0)
if mode == "crash-exit1":
    sys.exit(1)
if mode == "garbage":
    print("not json at all"); sys.exit(0)
if mode == "sleep":
    time.sleep(10); sys.exit(0)
if mode == "harness":
    import socket
    s = socket.socket(socket.AF_UNIX)
    s.connect("/tmp/harness.sock")
    sys.exit(0)
sys.exit(0)
