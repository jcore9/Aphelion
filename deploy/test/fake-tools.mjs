import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const [root, port] = process.argv.slice(2);

createServer((request, response) => {
  try {
    response.end(readFileSync(`${root}/${(request.url ?? "").slice(1)}`));
  } catch {
    response.statusCode = 404;
    response.end();
  }
}).listen(Number(port), "127.0.0.1");
