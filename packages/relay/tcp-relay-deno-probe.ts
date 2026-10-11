// Can this host run the relay? It needs a raw TCP connection to port 443 that the platform
// does not wrap in TLS. GET / tries one to PROBE_HOST (default opencode.ai), sends a plain
// HTTP request (which an https port answers in plain text, with a 400) and reports what came back.
Deno.serve(async () => {
  const hostname = Deno.env.get("PROBE_HOST") ?? "opencode.ai";
  const report: Record<string, unknown> = { hostname, port: 443 };
  try {
    const conn = await Deno.connect({ hostname, port: 443 });
    report.connected = true;
    report.remote = (conn.remoteAddr as Deno.NetAddr).hostname;
    await conn.write(new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`));
    const buffer = new Uint8Array(512);
    const read = await conn.read(buffer);
    report.firstBytes = new TextDecoder().decode(buffer.subarray(0, read ?? 0)).slice(0, 200);
    conn.close();
  } catch (error) {
    report.connected ??= false;
    report.error = `${(error as Error).name}: ${(error as Error).message}`;
  }
  return Response.json(report);
});
