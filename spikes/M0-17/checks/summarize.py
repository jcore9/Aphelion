# Summarizes one probe log: each tool item, whether an approval request came first, and its result.
# Spike code for M0-17. Never merged.
import json
import os
import sys

label, path, ws = sys.argv[1], sys.argv[2], sys.argv[3]
rows, current, errors = [], None, []
for line in open(path):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    ev, d = e["event"], e.get("data") or {}
    if ev == "item/started" and d.get("type") in ("commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"):
        what = d.get("command") or d.get("tool") or d.get("query") or d.get("changes") or d.get("type")
        current = {"type": d["type"], "what": str(what)[:60], "asked": [], "result": None}
        rows.append(current)
    elif ev == "server_request":
        if current is None or current["result"] is not None:
            current = {"type": "(no item)", "what": "", "asked": [], "result": "-"}
            rows.append(current)
        current["asked"].append(d["method"].split("/")[1] if "/" in d["method"] else d["method"])
    elif ev == "item/completed" and current is not None and d.get("type") == current["type"]:
        current["result"] = f'{d.get("status")}' + (f' exit={d.get("exitCode")}' if d.get("exitCode") is not None else "") + (f' err={d.get("error")}' if d.get("error") else "")
    elif ev.endswith("_error") or ev == "error":
        errors.append(json.dumps(d)[:300])
print(f"== {label}")
for r in rows:
    print(f'  {r["type"]:<17} {r["what"]:<62} asked={",".join(r["asked"]) or "NO":<22} {r["result"]}')
for x in errors:
    print("  ERROR", x)
print("  files:", sorted(os.listdir(ws)))
