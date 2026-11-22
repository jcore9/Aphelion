# A scripted stand-in for the OpenAI Responses API, so approval behavior can be
# tested without a login or any plan usage. Spike code for M0-17. Never merged.
#
# The script is a JSON array of steps. Each POST .../responses consumes one step:
#   {"call": "<tool>", "args": {...}}   the model calls that function tool
#   {"call": "apply_patch", "args": "*** Begin Patch ..."}   a freeform apply_patch call
#   {"raw": {...}}                      that output item, verbatim (for example a web_search_call)
#   {"say": "text"}                     the model answers and the turn ends
# POST /reset reloads the script. python3 -I mock_responses.py PORT SCRIPT_FILE LOG_FILE
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, script_file, log_file = int(sys.argv[1]), sys.argv[2], sys.argv[3]
state = {"script": json.load(open(script_file)), "step": 0}


def log(event, data):
    with open(log_file, "a") as f:
        f.write(json.dumps({"t": time.time(), "event": event, "data": data}) + "\n")


def item_for(s, n):
    if "raw" in s:
        return s["raw"]
    if "call" in s:
        if s["call"] == "apply_patch" and isinstance(s["args"], str):
            return {"type": "custom_tool_call", "id": f"ctc_{n}", "call_id": f"call_{n}", "name": "apply_patch", "input": s["args"], "status": "completed"}
        return {"type": "function_call", "id": f"fc_{n}", "call_id": f"call_{n}", "name": s["call"], "arguments": json.dumps(s["args"]), "status": "completed"}
    return {"type": "message", "id": f"msg_{n}", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": s["say"], "annotations": []}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        data = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        log("get", self.path)
        if self.path.split("?")[0].endswith("/models"):
            return self._send(200, json.dumps({"object": "list", "data": [], "models": []}), "application/json")
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path == "/reset":
            state["script"], state["step"] = json.load(open(script_file)), 0
            return self._send(200, "ok", "text/plain")
        if not self.path.split("?")[0].endswith("/responses"):
            log("unhandled", self.path)
            return self._send(404, "not found", "text/plain")
        if self.headers.get("content-encoding") == "zstd":
            log("compressed_body", self.path)
            return self._send(400, "compressed", "text/plain")
        body = json.loads(raw)
        tools = [t.get("name") or t.get("type") for t in body.get("tools", [])]
        outs = [i for i in body.get("input", []) if i.get("type") in ("function_call_output", "custom_tool_call_output")]
        last = outs[-1].get("output") if outs else None
        if body.get("input"):
            log("last_input_items", [{k: (v if k != "output" else str(v)[:400]) for k, v in i.items() if k not in ("content", "encrypted_content")} for i in body["input"][-2:]])
            if state["step"] > 0:
                log("tools_full", [t for t in body.get("tools", []) if (t.get("name") or t.get("type")) not in ("exec_command", "apply_patch", "write_stdin")][:12])
        log("request", {"marker": "MARKER-42" in raw.decode(errors="replace"), "items": len(body.get("input", [])), "step": state["step"], "tools": tools, "lastOutput": (last if isinstance(last, str) else json.dumps(last))[:300] if last is not None else None})
        script = state["script"]
        s = script[state["step"]] if state["step"] < len(script) else {"say": "done"}
        state["step"] += 1
        n = state["step"]
        item = item_for(s, n)
        usage = {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 15}
        events = [
            {"type": "response.created", "response": {"id": f"resp_{n}", "status": "in_progress"}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": f"resp_{n}", "status": "completed", "output": [item], "usage": usage}},
        ]
        self._send(200, "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events), "text/event-stream")


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
