import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [releases, port = "8099"] = process.argv.slice(2);
if (releases === undefined) {
  process.stderr.write("usage: bun fake-github.mjs RELEASES [PORT]\n");
  process.exit(1);
}
const origin = `http://127.0.0.1:${port}`;

function answer(path) {
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(path)) {
    const tag = readFileSync(join(releases, "latest"), "utf8").trim();
    const json = readFileSync(join(releases, tag, "release.json"), "utf8");
    return json.replaceAll("https://github.com", origin);
  }
  const asset =
    /^\/[^/]+\/[^/]+\/releases\/download\/(v[\d.]+)\/([\w.-]+)$/.exec(path);
  return asset === null
    ? undefined
    : readFileSync(join(releases, asset[1], asset[2]));
}

createServer((request, response) => {
  let body;
  try {
    body = answer(request.url ?? "");
  } catch {
    body = undefined;
  }
  if (body === undefined) response.statusCode = 404;
  response.end(body);
}).listen(Number(port), "127.0.0.1");
