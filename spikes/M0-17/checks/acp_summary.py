# Summarizes an acp-probe log. Spike code for M0-17. Never merged.
import json, sys
for l in sys.stdin:
    e = json.loads(l); ev = e["event"]; d = e["data"]
    if ev == "tool_call": print(f"  tool_call   {str(d.get('title'))[:50]:<50} kind={d.get('kind')}")
    elif ev == "permission_request": print(f"  >> PERMISSION {str(d.get('tool'))[:45]} options={d.get('options')}")
    elif ev == "tool_call_update" and d.get("status") in ("completed", "failed"): print(f"     done {d.get('status')}")
    elif ev in ("error", "prompt_done", "mode_set", "session_new"): print(" ", ev, json.dumps(d)[:300])
