// Cliente MCP mínimo por stdio: initialize, tools/list e, com argumentos, uma tools/call.
// node scripts/mcp-call.mjs <pasta-da-integração> ['<argumentos em JSON>']
// ENDPOINT (padrão ws://localhost:9555/pw) é o navegador de scripts/browser.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const [, , artifact, toolArgs] = process.argv;
const endpoint = process.env.ENDPOINT ?? "ws://localhost:9555/pw";
const bin = fileURLToPath(new URL("../node_modules/pomerado/dist/typescript/src/standalone/mcp-cli.js", import.meta.url));
const child = spawn(process.execPath, [bin, "serve", "--artifact", artifact, "--endpoint", endpoint], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let id = 0;
const call = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "0" } });
console.log("servidor:", JSON.stringify(init.result?.serverInfo), "protocolo", init.result?.protocolVersion);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await call("tools/list", {});
for (const t of list.result.tools) console.log("ferramenta:", t.name, JSON.stringify(t.inputSchema).slice(0, 300));
if (!toolArgs) { child.kill(); process.exit(0); }
const main = list.result.tools.find((t) => !["get_job", "provide_input", "cancel_job"].includes(t.name));
const t0 = Date.now();
let res = await call("tools/call", { name: main.name, arguments: JSON.parse(toolArgs) });
console.log("1a resposta:", JSON.stringify(res.result?.structuredContent ?? res.result).slice(0, 800));
for (let k = 0; k < 20; k++) {
  const sc = res.result?.structuredContent;
  const jobId = sc?.job_id ?? sc?.jobId ?? sc?.job?.job_id ?? sc?.job?.id;
  if (!jobId || (sc?.status && !/running|pending|queued|working/.test(sc.status))) break;
  res = await call("tools/call", { name: "get_job", arguments: { job_id: jobId } });
}
console.log("tempo", ((Date.now() - t0) / 1000).toFixed(1), "s");
console.log(JSON.stringify(res.result?.structuredContent ?? res.result ?? res.error).slice(0, 6000));
child.kill();
