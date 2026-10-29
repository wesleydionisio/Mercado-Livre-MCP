// Ponte: expõe o subconjunto da Responses API da OpenAI que o Pomerado usa no mint
// e responde com o Claude pela Messages API (SDK oficial).
//
// node bridge/bridge.mjs [pasta-de-log]   (padrão logs/bridge)
// Chave: ANTHROPIC_API_KEY, ou ANTHROPIC_API_KEY_FILE com o caminho de um arquivo que a contém.
// Env: SOL_MODEL, LUNA_MODEL, PORT (9777), BUDGET_USD (20), DUMP_ALL=1

import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const logDir = process.argv[2] ?? "logs/bridge";
mkdirSync(logDir, { recursive: true });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY_FILE
    ? readFileSync(process.env.ANTHROPIC_API_KEY_FILE, "utf8").trim()
    : process.env.ANTHROPIC_API_KEY,
  maxRetries: 4,
  timeout: 20 * 60 * 1000,
});

const MODELS = {
  "gpt-6.1-sol": process.env.SOL_MODEL ?? "claude-opus-5-5",
  "gpt-6-luna": process.env.LUNA_MODEL ?? "claude-haiku-5-5",
};
// Fallback do servidor ("default") só onde a API aceita.
const SERVER_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
// US$ por milhão: entrada, saída, leitura de cache, escrita de cache (5 min).
const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
const BUDGET_USD = Number(process.env.BUDGET_USD ?? "20");
let spentUsd = 0;
let requestCount = 0;

const log = (record) =>
  appendFileSync(`${logDir}/bridge.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;

// ---- Ferramenta apply_patch (nativa na OpenAI, comum para o Claude) ----

const APPLY_PATCH_TOOL = {
  name: "apply_patch",
  description: [
    "Create, update or delete one file in the workspace. Use one call per file.",
    "type=create_file: `diff` holds the whole new file, every line prefixed with '+' (an empty line is just '+').",
    "type=update_file: `diff` is a headerless V4A diff. Each change section starts with a line '@@' or '@@ <exact existing line used as anchor, e.g. a function signature>',",
    "followed by up to 3 unchanged context lines prefixed with ' ' (one space), removed lines prefixed with '-', added lines prefixed with '+', and up to 3 unchanged context lines after.",
    "Context and removed lines must match the current file exactly. Do not use line numbers, unified-diff headers ('---', '+++') or '*** Begin Patch' wrappers.",
    "type=delete_file: `diff` is an empty string.",
    "Paths are relative to the workspace root.",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["create_file", "update_file", "delete_file"] },
      path: { type: "string" },
      diff: { type: "string" },
    },
    required: ["type", "path", "diff"],
    additionalProperties: false,
  },
};

// ---- Responses -> Messages ----

const reasoningPrefix = "claude-thinking:";
const encodeThinking = (block) => reasoningPrefix + Buffer.from(JSON.stringify(block)).toString("base64");
const decodeThinking = (item) => {
  const value = item.encrypted_content;
  if (typeof value !== "string" || !value.startsWith(reasoningPrefix)) return [];
  try {
    return [JSON.parse(Buffer.from(value.slice(reasoningPrefix.length), "base64").toString("utf8"))];
  } catch {
    return [];
  }
};

// A compactação da OpenAI devolve um item opaco que substitui todo o prefixo, instruções
// incluídas; aqui ele leva o system original e um resumo escrito pelo próprio Claude.
const compactionPrefix = "claude-compaction:";
const encodeCompaction = (value) => compactionPrefix + Buffer.from(JSON.stringify(value)).toString("base64");
const decodeCompaction = (item) => {
  const value = item.encrypted_content;
  if (typeof value !== "string" || !value.startsWith(compactionPrefix)) return undefined;
  try {
    return JSON.parse(Buffer.from(value.slice(compactionPrefix.length), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
};
const COMPACTION_REQUEST = [
  "Context compaction: this conversation is about to be replaced by a summary, followed by the most recent items.",
  "Do not call any tool now. Write the summary you will need to continue the task without the earlier turns:",
  "the task and its constraints, what you learned about the site (URLs, selectors, request mechanics, anti-bot behaviour),",
  "the files you created or changed and their current state, what was tested and the results, open problems, and the next steps.",
  "Be specific and complete; include exact names, paths, selectors and values.",
].join(" ");

// Restrições de esquema que a saída estruturada do Claude não aceita; o Pomerado valida depois.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const sanitizeSchema = (schema) => {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
};

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((part) => part.text ?? part.refusal ?? "")
        .filter(Boolean)
        .join("\n\n");

const imageBlock = (url) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url ?? "");
  if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  if (typeof url === "string" && /^https?:/.test(url)) return { type: "image", source: { type: "url", url } };
  return undefined;
};

const userBlocks = (content) => {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks = [];
  for (const part of content ?? []) {
    if ((part.type === "input_text" || part.type === "text" || part.type === "output_text") && part.text)
      blocks.push({ type: "text", text: part.text });
    else if (part.type === "input_image") {
      const image = imageBlock(part.image_url);
      if (image) blocks.push(image);
    } else if (part.type === "input_file" && typeof part.file_data === "string") {
      const match = /^data:application\/pdf;base64,(.*)$/s.exec(part.file_data);
      if (match) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: match[1] } });
    } else unknown("user_part", part.type);
  }
  return blocks;
};

const toolResultContent = (output) => {
  if (typeof output === "string") return output;
  const blocks = userBlocks(output).filter((block) => block.type === "text" || block.type === "image");
  return blocks.length > 0 ? blocks : "";
};

const parseArguments = (value) => {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
};

const unknownSeen = new Set();
function unknown(kind, type) {
  const key = `${kind}:${type}`;
  if (unknownSeen.has(key)) return;
  unknownSeen.add(key);
  log({ warn: "unknown", kind, type });
}

function toMessages(input) {
  const items = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : (input ?? []);
  const system = [];
  const messages = [];
  let conversationStarted = false;
  const push = (role, block) => {
    let last = messages.at(-1);
    if (last === undefined || last.role !== role) {
      last = { role, content: [] };
      messages.push(last);
    }
    last.content.push(block);
  };
  for (const item of items) {
    const type = item.type ?? "message";
    if (type === "message" && (item.role === "developer" || item.role === "system")) {
      const text = textOf(item.content);
      if (!text) continue;
      if (!conversationStarted) system.push(text);
      else push("user", { type: "text", text: `<developer_message>\n${text}\n</developer_message>` });
      continue;
    }
    if (type === "compaction") {
      const compacted = decodeCompaction(item);
      if (compacted === undefined) {
        unknown("compaction", "foreign");
        continue;
      }
      if (!conversationStarted) system.push(...compacted.system);
      conversationStarted = true;
      push("user", { type: "text", text: `<compacted_history>\n${compacted.summary}\n</compacted_history>` });
      continue;
    }
    if (type === "compaction_trigger") {
      push("user", { type: "text", text: COMPACTION_REQUEST });
      continue;
    }
    conversationStarted = true;
    if (type === "message" && item.role === "user") for (const block of userBlocks(item.content)) push("user", block);
    else if (type === "message" && item.role === "assistant") {
      for (const part of typeof item.content === "string" ? [{ text: item.content }] : (item.content ?? [])) {
        const text = part.text ?? part.refusal;
        if (text) push("assistant", { type: "text", text });
      }
    } else if (type === "reasoning") for (const block of decodeThinking(item)) push("assistant", block);
    else if (type === "function_call")
      push("assistant", { type: "tool_use", id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    else if (type === "apply_patch_call")
      push("assistant", { type: "tool_use", id: item.call_id, name: "apply_patch", input: item.operation });
    else if (type === "function_call_output")
      push("user", { type: "tool_result", tool_use_id: item.call_id, content: toolResultContent(item.output) });
    else if (type === "apply_patch_call_output")
      push("user", {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: item.output || (item.status === "failed" ? "failed" : "completed"),
        ...(item.status === "failed" ? { is_error: true } : {}),
      });
    else unknown("input_item", type);
  }
  return { system, messages: normalize(messages) };
}

// Pares tool_use/tool_result válidos para o Claude, resultados primeiro e nada de prefill.
function normalize(messages) {
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type !== "text" || block.text);
      if (content.length === 0) continue;
      if (out.length === 0) out.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });
      out.push({ role: "assistant", content });
      continue;
    }
    const previous = out.at(-1);
    const pending = new Set(
      previous?.role === "assistant"
        ? previous.content.filter((block) => block.type === "tool_use").map((block) => block.id)
        : [],
    );
    const results = [];
    const others = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        if (pending.delete(block.tool_use_id)) results.push(block);
        else others.push({ type: "text", text: `Tool output (${block.tool_use_id}):\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}` });
      } else others.push(block);
    }
    for (const id of pending)
      results.push({ type: "tool_result", tool_use_id: id, content: "Not run.", is_error: true });
    const content = [...results, ...others];
    if (content.length > 0) out.push({ role: "user", content });
  }
  // Uma chamada de ferramenta sem resposta no fim do histórico também precisa de resultado.
  const last = out.at(-1);
  if (last?.role === "assistant") {
    const ids = last.content.filter((block) => block.type === "tool_use").map((block) => block.id);
    out.push({
      role: "user",
      content: ids.length > 0
        ? ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Not run.", is_error: true }))
        : [{ type: "text", text: "Continue." }],
    });
  }
  return out;
}

function toTools(tools) {
  const out = [];
  for (const tool of tools ?? []) {
    if (tool.type === "function")
      out.push({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.parameters ?? { type: "object", properties: {} },
      });
    else if (tool.type === "apply_patch") out.push(APPLY_PATCH_TOOL);
    else unknown("tool", tool.type);
  }
  return out;
}

const EFFORTS = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

function toRequest(body, { schemaInPrompt = false } = {}) {
  const model = MODELS[body.model] ?? body.model;
  const { system, messages } = toMessages(body.input);
  if (typeof body.instructions === "string" && body.instructions) system.unshift(body.instructions);
  const format = body.text?.format;
  const outputConfig = { effort: EFFORTS[body.reasoning?.effort] ?? "medium" };
  if (format?.type === "json_schema") {
    if (schemaInPrompt)
      system.push(`Reply with only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(format.schema)}`);
    else outputConfig.format = { type: "json_schema", schema: sanitizeSchema(format.schema) };
  }
  const tools = toTools(body.tools);
  const betas = ["thinking-binding-controls-2026-08-01"];
  const request = {
    model,
    max_tokens: body.max_output_tokens ?? (model.includes("haiku") ? 16000 : 64000),
    system: system.length > 0 ? [{ type: "text", text: system.join("\n\n"), cache_control: { type: "ephemeral" } }] : undefined,
    messages,
    thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: outputConfig,
    cache_control: { type: "ephemeral" },
  };
  if (tools.length > 0) {
    request.tools = tools;
    if (body.tool_choice === "none") request.tool_choice = { type: "none" };
    else if (body.parallel_tool_calls === false) request.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  if (SERVER_FALLBACK.has(model)) {
    betas.push("server-side-fallback-2026-07-01");
    request.fallbacks = "default";
  }
  request.betas = betas;
  return request;
}

// ---- Messages -> Responses ----

function toResponse(body, message, request) {
  const output = [];
  const compacting = Array.isArray(body.input) && body.input.at(-1)?.type === "compaction_trigger";
  const summary = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  if (compacting && summary)
    output.push({
      type: "compaction",
      id: newId("cmp"),
      encrypted_content: encodeCompaction({ system: request.system?.map((block) => block.text) ?? [], summary }),
    });
  for (const block of compacting ? [] : message.content) {
    if (block.type === "thinking" || block.type === "redacted_thinking")
      output.push({
        type: "reasoning",
        id: newId("rs"),
        summary: block.type === "thinking" && block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
        encrypted_content: encodeThinking(block),
      });
    else if (block.type === "text") {
      if (block.text)
        output.push({
          type: "message",
          id: newId("msg"),
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        });
    } else if (block.type === "tool_use") {
      if (block.name === "apply_patch")
        output.push({ type: "apply_patch_call", id: newId("apc"), call_id: block.id, status: "completed", operation: block.input });
      else
        output.push({
          type: "function_call",
          id: newId("fc"),
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        });
    } else if (block.type !== "fallback") unknown("claude_block", block.type);
  }
  if (message.stop_reason === "refusal")
    output.push({
      type: "message",
      id: newId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: message.stop_details?.explanation ?? "The model declined this request." }],
    });
  const usage = message.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheRead + cacheWrite;
  const incomplete = message.stop_reason === "max_tokens";
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    error: null,
    model: body.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    store: false,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: cacheRead },
      output_tokens: usage.output_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + usage.output_tokens,
    },
  };
}

function costOf(model, usage) {
  const [input, output, read, write] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      (usage.cache_read_input_tokens ?? 0) * read +
      (usage.cache_creation_input_tokens ?? 0) * write) /
    1e6
  );
}

async function complete(body) {
  let request = toRequest(body);
  try {
    return { request, message: await client.beta.messages.stream(request).finalMessage() };
  } catch (error) {
    // Esquema que a saída estruturada do Claude não aceita: pede o JSON pelo prompt.
    if (error instanceof Anthropic.BadRequestError && request.output_config.format !== undefined && /schema/i.test(error.message)) {
      log({ warn: "schema_fallback", error: error.message.slice(0, 500) });
      request = toRequest(body, { schemaInPrompt: true });
      return { request, message: await client.beta.messages.stream(request).finalMessage() };
    }
    throw error;
  }
}

const send = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const number = ++requestCount;
    if (req.method !== "POST" || !req.url.startsWith("/v1/responses")) {
      log({ number, warn: "unsupported_endpoint", method: req.method, url: req.url });
      return send(res, 404, { error: { message: `Unsupported ${req.method} ${req.url}`, type: "invalid_request_error" } });
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.stream === true) {
      log({ number, warn: "stream_requested" });
      return send(res, 400, { error: { message: "Streaming is not supported by this bridge.", type: "invalid_request_error" } });
    }
    if (spentUsd >= BUDGET_USD) {
      log({ number, warn: "budget_exhausted", spentUsd });
      return send(res, 429, { error: { message: "Bridge budget exhausted.", type: "insufficient_quota", code: "insufficient_quota" } });
    }
    const started = Date.now();
    // O que chegou de novo desde a última saída do modelo (resultados de ferramentas, avisos).
    if (Array.isArray(body.input)) {
      const lastOutput = body.input.findLastIndex((item) =>
        ["reasoning", "function_call", "apply_patch_call"].includes(item.type) || (item.type === "message" && item.role === "assistant"),
      );
      const fresh = body.input.slice(lastOutput + 1).map((item) => {
        const text = item.output ?? item.content ?? item.type;
        return { type: item.type ?? "message", role: item.role, call: item.call_id, text: (typeof text === "string" ? text : JSON.stringify(text)).slice(0, 2500) };
      });
      appendFileSync(`${logDir}/inputs.jsonl`, `${JSON.stringify({ number, model: body.model, fresh })}\n`);
    }
    try {
      const { request, message } = await complete(body);
      const cost = costOf(message.model ?? request.model, message.usage);
      spentUsd += cost;
      const response = toResponse(body, message, request);
      if (number <= 3 || process.env.DUMP_ALL === "1") {
        const { system, ...rest } = request;
        writeFileSync(`${logDir}/req-${number}.json`, JSON.stringify({ ...rest, systemChars: JSON.stringify(system ?? "").length }, null, 1));
        writeFileSync(`${logDir}/res-${number}.json`, JSON.stringify({ message, response }, null, 1));
      }
      log({
        number,
        model: request.model,
        served: message.model,
        ms: Date.now() - started,
        stop: message.stop_reason,
        messages: request.messages.length,
        blocks: message.content.map((block) => (block.type === "tool_use" ? `tool:${block.name}` : block.type)),
        usage: message.usage,
        transformations: message.input_transformations?.length ?? undefined,
        cost: Number(cost.toFixed(4)),
        spentUsd: Number(spentUsd.toFixed(4)),
      });
      send(res, 200, response);
    } catch (error) {
      const status = error instanceof Anthropic.APIError && error.status ? error.status : 500;
      log({ number, error: String(error?.message ?? error).slice(0, 2000), status, ms: Date.now() - started });
      send(res, status, { error: { message: String(error?.message ?? error), type: status === 429 ? "rate_limit_exceeded" : "invalid_request_error" } });
    }
  });
}).listen(Number(process.env.PORT ?? "9777"), "127.0.0.1", () => console.log("bridge listening"));
