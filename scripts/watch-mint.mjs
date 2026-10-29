// Acompanha a ponte: custo, erros, e o que o Pomerado responde a finish_build/report_blocked/request_input.
import { openSync, readSync, fstatSync, existsSync } from "node:fs";
const [, , dir, mintLog] = process.argv;
const files = { bridge: `${dir}/bridge.jsonl`, inputs: `${dir}/inputs.jsonl`, mint: mintLog };
const offsets = {};
for (const [k, f] of Object.entries(files)) offsets[k] = existsSync(f) ? fstatSync(openSync(f, "r")).size : 0;
const read = (k) => {
  if (!existsSync(files[k])) return [];
  const fd = openSync(files[k], "r");
  const size = fstatSync(fd).size;
  if (size <= offsets[k]) return [];
  const buf = Buffer.alloc(size - offsets[k]);
  readSync(fd, buf, 0, buf.length, offsets[k]);
  const text = buf.toString("utf8");
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return [];
  offsets[k] += Buffer.byteLength(text.slice(0, cut + 1));
  return text.slice(0, cut).split("\n").filter(Boolean);
};
let pending = null, n = 0, last = 0;
setInterval(() => {
  for (const line of read("bridge")) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.warn) { console.log(`PONTE AVISO ${r.warn} ${r.type ?? r.kind ?? ""} ${(r.error ?? "").slice(0, 200)}`); continue; }
    if (r.error) { console.log(`PONTE ERRO ${r.status}: ${r.error.slice(0, 300)}`); continue; }
    n++;
    const key = r.blocks.find((b) => /finish_build|report_blocked|request_input/.test(b));
    if (key && r.model.includes("opus")) { pending = key; console.log(`PONTE #${r.number} US$ ${r.spentUsd} chamou ${key}`); }
    else if (n % 20 === 0 || r.spentUsd - last > 2) { last = r.spentUsd; console.log(`PONTE #${r.number} US$ ${r.spentUsd}`); }
  }
  for (const line of read("inputs")) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!pending || r.model !== "gpt-6.1-sol") continue;
    const outs = r.fresh.filter((f) => f.type === "function_call_output").map((f) => f.text.replace(/\s+/g, " ").slice(0, 900));
    console.log(`RESPOSTA a ${pending} (#${r.number}): ${outs.join(" || ") || JSON.stringify(r.fresh).slice(0, 600)}`);
    pending = null;
  }
  for (const line of read("mint")) if (line.trim()) console.log(`MINT ${line}`);
}, 1000);
