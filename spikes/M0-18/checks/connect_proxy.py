# Logging HTTP CONNECT proxy for the M0-17 egress test. Spike code. Never merged.
import select, socket, sys, threading, time
LOG = sys.argv[1]
def log(line):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
def pipe(a, b):
    socks = [a, b]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r: return
            for s in r:
                d = s.recv(65536)
                if not d: return
                (b if s is a else a).sendall(d)
    except OSError:
        pass
    finally:
        a.close(); b.close()
def handle(c):
    try:
        head = b""
        while b"\r\n\r\n" not in head:
            d = c.recv(4096)
            if not d: return
            head += d
        first = head.split(b"\r\n")[0].decode()
        method, target = first.split(" ")[:2]
        log(f"{method} {target}")
        if method == "CONNECT":
            host, port = target.rsplit(":", 1)
            u = socket.create_connection((host, int(port)), timeout=15)
            c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            pipe(c, u)
        else:
            c.sendall(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"); c.close()
    except Exception as e:
        log(f"ERR {type(e).__name__} {e}")
        c.close()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 3128)); srv.listen(64)
while True:
    c, _ = srv.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
