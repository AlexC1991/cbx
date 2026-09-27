/**
 * A proxy that forwards to the real service and then hangs up.
 *
 * Publishing is meant to survive a connection lost *after* the version was
 * written — the case where the work succeeded and the client never heard.
 * That cannot be produced by throwing inside the client, because then the
 * request never happened; it has to be produced at the socket.
 *
 * So this forwards the request faithfully, waits for the real answer, and
 * then destroys the connection without sending it. The server has committed;
 * the client sees a network failure. Which is precisely the situation the
 * idempotency key exists for.
 *
 *   node drop-proxy.mjs 8787
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);
const UPSTREAM = "https://api.coderook.com";

/** Requests matching this are answered by hanging up, once each. */
const dropOnce = new Set(["POST /v1/repositories/"]);
const dropped = new Set();

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (["host", "connection", "content-length"].includes(name)) continue;
    if (typeof value === "string") headers.set(name, value);
  }

  const upstream = await fetch(`${UPSTREAM}${request.url}`, {
    method: request.method,
    headers,
    ...(body.length ? { body } : {}),
  });
  const answer = Buffer.from(await upstream.arrayBuffer());

  const shouldDrop =
    request.method === "POST" &&
    /^\/v1\/repositories\/[^/]+\/versions$/.test(request.url ?? "") &&
    !dropped.has(request.url);
  if (shouldDrop) {
    dropped.add(request.url);
    console.log(
      `  proxy: upstream answered ${upstream.status}; hanging up without replying`,
    );
    // The work is done and committed. The client will never learn that.
    request.socket.destroy();
    return;
  }

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(answer);
});

server.listen(port, () => console.log(`  proxy listening on ${port}`));
