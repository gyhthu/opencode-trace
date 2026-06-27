#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 5010);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const LOG_DIR = process.env.RAW_TRACE_DIR || path.join(process.env.HOME || process.cwd(), ".local/share/opencode-trace/logs");

function safeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") continue;
    result[key] = value;
  }
  return result;
}

function upstreamHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) continue;
    result[key] = value;
  }
  return result;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function collectSse(text, aggregate, final = false) {
  aggregate.buffer += text;
  const lines = aggregate.buffer.split(/\r?\n/);
  aggregate.buffer = final ? "" : lines.pop() || "";

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    aggregate.rawEvents.push(data);
    const parsed = parseJson(data);
    if (!parsed) continue;

    aggregate.parsedEvents.push(parsed);
    for (const choice of parsed.choices || []) {
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === "string") aggregate.reasoningContent += delta.reasoning_content;
      if (typeof delta.content === "string") aggregate.content += delta.content;

      for (const call of delta.tool_calls || []) {
        const index = call.index || 0;
        const existing = aggregate.toolCalls.get(index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) existing.id += call.id;
        if (call.type) existing.type = call.type;
        if (call.function) {
          if (call.function.name) existing.function.name += call.function.name;
          if (call.function.arguments) existing.function.arguments += call.function.arguments;
        }
        aggregate.toolCalls.set(index, existing);
      }

      if (choice.finish_reason) aggregate.finishReason = choice.finish_reason;
    }
    if (parsed.usage) aggregate.usage = parsed.usage;
  }
}

async function persist(record) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const filename = `${record.started_at.replace(/[:.]/g, "-")}-${record.id}.json`;
  const file = path.join(LOG_DIR, filename);
  record.raw_trace_file = file;
  await fs.writeFile(file, JSON.stringify(record, null, 2));
}

async function proxyRequest(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true, upstream: UPSTREAM_BASE_URL, log_dir: LOG_DIR });
    return;
  }

  const id = randomUUID();
  const started = new Date();
  const requestBody = await readBody(req);
  const requestText = requestBody.toString("utf8");
  const rawRequest = parseJson(requestText);
  const upstreamUrl = `${UPSTREAM_BASE_URL}${req.url}`;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers: upstreamHeaders(req.headers),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : requestBody,
  });

  const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
  const clientHeaders = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      clientHeaders[key] = value;
    }
  });
  res.writeHead(upstreamResponse.status, clientHeaders);

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const isStream = contentType.includes("text/event-stream");

  if (isStream && upstreamResponse.body) {
    const aggregate = {
      buffer: "",
      rawEvents: [],
      parsedEvents: [],
      toolCalls: new Map(),
      reasoningContent: "",
      content: "",
      usage: null,
      finishReason: null,
    };

    const decoder = new TextDecoder();
    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collectSse(decoder.decode(value, { stream: true }), aggregate);
      res.write(Buffer.from(value));
    }
    collectSse(decoder.decode(), aggregate, true);
    res.end();

    await persist({
      id,
      started_at: started.toISOString(),
      completed_at: new Date().toISOString(),
      upstream: upstreamUrl,
      request_headers: safeHeaders(req.headers),
      response_headers: responseHeaders,
      status_code: upstreamResponse.status,
      raw_request: rawRequest || requestText,
      raw_response: null,
      raw_stream_events: aggregate.parsedEvents,
      tool_calls: [...aggregate.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
      reasoning_content: aggregate.reasoningContent,
      content: aggregate.content,
      usage: aggregate.usage,
      finish_reason: aggregate.finishReason,
    });
    return;
  }

  const responseText = await upstreamResponse.text();
  res.end(responseText);

  const parsedResponse = parseJson(responseText);
  const choice = parsedResponse && parsedResponse.choices && parsedResponse.choices[0];
  const message = choice && choice.message;
  await persist({
    id,
    started_at: started.toISOString(),
    completed_at: new Date().toISOString(),
    upstream: upstreamUrl,
    request_headers: safeHeaders(req.headers),
    response_headers: responseHeaders,
    status_code: upstreamResponse.status,
    raw_request: rawRequest || requestText,
    raw_response: parsedResponse || responseText,
    raw_stream_events: null,
    tool_calls: message && message.tool_calls,
    reasoning_content: message && message.reasoning_content,
    content: message && message.content,
    usage: parsedResponse && parsedResponse.usage,
    finish_reason: choice && choice.finish_reason,
  });
}

const server = http.createServer((req, res) => {
  proxyRequest(req, res).catch((error) => {
    console.error("[opencode-trace] request failed", error);
    if (!res.headersSent) writeJson(res, 502, { error: String(error && error.message ? error.message : error) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[opencode-trace] listening on http://${HOST}:${PORT}`);
  console.log(`[opencode-trace] upstream=${UPSTREAM_BASE_URL}`);
  console.log(`[opencode-trace] log_dir=${LOG_DIR}`);
});
