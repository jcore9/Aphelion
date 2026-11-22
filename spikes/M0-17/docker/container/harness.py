# Stand-in harness for the strict hook: answers every request with the word in argv[1]. Never merged.
import os, socket, sys
path = "/tmp/harness.sock"
if os.path.exists(path): os.unlink(path)
srv = socket.socket(socket.AF_UNIX); srv.bind(path); srv.listen(8)
while True:
    c, _ = srv.accept(); c.recv(65536); c.sendall((sys.argv[1] + "\n").encode()); c.close()
