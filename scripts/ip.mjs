// Mostra o IP de saída do navegador de scripts/browser.mjs (confere o proxy antes de abrir o ML).
// ENDPOINT (padrão ws://localhost:9555/pw).
import { chromium } from "patchright";

const browser = await chromium.connect(process.env.ENDPOINT ?? "ws://localhost:9555/pw");
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://ipinfo.io/json", { timeout: 60000 });
const info = JSON.parse(await page.locator("body").innerText());
console.log(info.ip, info.city, info.region, info.country, info.org);
await context.close();
await browser.close();
