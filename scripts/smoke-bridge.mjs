// Teste rápido da ponte: duas chamadas da Responses API com uma ferramenta (gasta centavos no Haiku).
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "bridge", baseURL: "http://127.0.0.1:9777/v1" });
const tools = [{ type: "function", name: "get_price", description: "Get the price of a product id", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, strict: true }];
const first = await client.responses.create({ model: "gpt-6-luna", input: [{ role: "developer", content: "Use tools when needed. Answer in Portuguese, one short sentence." }, { role: "user", content: "Quanto custa o produto MLB123?" }], tools, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"], store: false });
console.log("1:", first.output.map((o) => o.type + (o.name ? ":" + o.name + " " + o.arguments : "")));
const call = first.output.find((o) => o.type === "function_call");
const second = await client.responses.create({ model: "gpt-6-luna", input: [{ role: "developer", content: "Use tools when needed. Answer in Portuguese, one short sentence." }, { role: "user", content: "Quanto custa o produto MLB123?" }, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "R$ 189,90 (de R$ 249,00)" }], tools, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"], store: false });
console.log("2:", second.output_text, second.usage);
