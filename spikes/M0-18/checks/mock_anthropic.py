# Scripted stand-in for the Anthropic Messages API, so Claude Code runs one Bash tool call with no login.
# Usage: python3 -I mock_anthropic.py <port> <command> <log>
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, command, log = int(sys.argv[1]), sys.argv[2], sys.argv[3]

def has_tool_result(body):
    for m in body.get("messages", []):
        c = m.get("content")
        if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return [b for b in c if isinstance(b, dict) and b.get("type") == "tool_result"]
    return None

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b"{}")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        tools = [t.get("name") for t in body.get("tools", [])]
        results = has_tool_result(body)
        with open(log, "a") as f:
            f.write(json.dumps({"path": self.path, "tools": len(tools), "tool_result": results}) + "\n")
        if "count_tokens" in self.path:
            return self.json({"input_tokens": 1})
        if results is None and "Bash" in tools:
            block = {"type": "tool_use", "id": "toolu_m018", "name": "Bash", "input": {"command": command, "description": "probe"}}
            stop = "tool_use"
        else:
            block = {"type": "text", "text": "done"}
            stop = "end_turn"
        msg = {"id": "msg_m018", "type": "message", "role": "assistant", "model": body.get("model", "mock"),
               "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
        if not body.get("stream"):
            msg.update(content=[block], stop_reason=stop); return self.json(msg)
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        start = dict(block, input={}) if block["type"] == "tool_use" else dict(block, text="")
        delta = ({"type": "input_json_delta", "partial_json": json.dumps(block["input"])} if block["type"] == "tool_use"
                 else {"type": "text_delta", "text": block["text"]})
        for ev, data in [("message_start", {"type": "message_start", "message": msg}),
                         ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": start}),
                         ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
                         ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                         ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                         ("message_stop", {"type": "message_stop"})]:
            self.wfile.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode()); self.wfile.flush()
    def json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
