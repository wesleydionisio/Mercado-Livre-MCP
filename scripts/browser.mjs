// Servidor patchright com janela; o Pomerado liga nele por --endpoint.
// PROXY_URL=http://usuario:senha@host:porta faz o navegador sair pelo proxy; um {sid} na URL
// vira SID (ou um sorteado), e trocar o sid troca o IP nos proxies de sessão fixa.
// PORT (9555).
import { chromium } from "patchright";

const port = Number(process.env.PORT ?? "9555");
const sid = process.env.SID || Math.random().toString(36).slice(2, 10);
let proxy;
if (process.env.PROXY_URL) {
  const url = new URL(process.env.PROXY_URL.replace("{sid}", sid));
  proxy = { server: `${url.protocol}//${url.host}`, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}
const server = await chromium.launchServer({ headless: false, port, wsPath: "pw", proxy });
console.log("WS", server.wsEndpoint(), proxy ? `(proxy, sid ${sid})` : "(sem proxy)");
process.on("SIGINT", async () => { await server.close(); process.exit(0); });
process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
setInterval(() => {}, 1 << 30);
