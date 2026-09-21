#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_ORIGIN = "https://api.notion.com";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const allowedActions = new Set([
  "drop_before_upstream",
  "drop_after_upstream",
  "respond_status",
  "partial_pagination_after_upstream",
  "schema_missing_properties_after_upstream",
]);

export function createNotionFaultProxy({ rules, evidencePath, fetcher = fetch }) {
  const counters = new Map(rules.map((rule) => [rule.id, {
    seen: 0, applied: 0, awaitingPaginationFollowup: false,
  }]));
  prepareEvidence(evidencePath);

  return createServer(async (request, response) => {
    const startedAt = new Date().toISOString();
    const method = (request.method ?? "GET").toUpperCase();
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = incoming.pathname;
    const authorizationPresent = typeof request.headers.authorization === "string" &&
      /^Bearer\s+\S+$/i.test(request.headers.authorization);
    const notionVersion = typeof request.headers["notion-version"] === "string"
      ? request.headers["notion-version"] : null;
    const rule = selectRule(rules, counters, method, path);

    let requestBody;
    try {
      requestBody = await readBody(request, MAX_REQUEST_BYTES);
    } catch {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "error", status: 413, code: "validation_error", message: "Request too large" }));
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion,
        requestBody: Buffer.alloc(0), rule,
        upstreamReached: false, downstream: "rejected_too_large" }));
      return;
    }

    if (!path.startsWith("/v1/")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Only Notion /v1 routes are accepted" }));
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion,
        requestBody, rule: undefined,
        upstreamReached: false, downstream: "rejected_route" }));
      return;
    }

    if (rule?.action === "drop_before_upstream") {
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
        upstreamReached: false, downstream: "connection_dropped", faultSatisfied: true }));
      response.socket?.destroy();
      return;
    }

    if (rule?.phase === "pagination_followup") {
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
        upstreamReached: false, downstream: "pagination_followup_dropped", faultSatisfied: true }));
      response.socket?.destroy();
      return;
    }

    if (rule?.action === "respond_status") {
      const status = rule.status;
      const headers = { "content-type": "application/json", ...(rule.retryAfter ? { "retry-after": rule.retryAfter } : {}) };
      response.writeHead(status, headers);
      response.end(JSON.stringify(injectedError(status)));
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
        upstreamReached: false, downstream: `status_${status}`, retryAfter: rule.retryAfter, faultSatisfied: true }));
      return;
    }

    let upstreamRequestBody = requestBody;
    let upstreamRequestMutated = false;
    let faultPreconditionFailure = null;
    if (rule?.action === "partial_pagination_after_upstream") {
      try {
        const value = JSON.parse(requestBody.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
        value.page_size = 1;
        upstreamRequestBody = Buffer.from(JSON.stringify(value));
        upstreamRequestMutated = true;
      } catch {
        faultPreconditionFailure = "query_body_not_json_object";
      }
    }

    let upstreamResponse;
    let upstreamBody;
    try {
      const headers = forwardedHeaders(request.headers);
      const target = new URL(`${incoming.pathname}${incoming.search}`, UPSTREAM_ORIGIN);
      upstreamResponse = await fetcher(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : upstreamRequestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
      if (upstreamBody.byteLength > MAX_RESPONSE_BYTES) throw new Error("upstream_response_too_large");
    } catch (error) {
      record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
        upstreamReached: null, upstreamRequestMutated, downstream: "upstream_failed",
        failure: error instanceof Error ? error.name : typeof error }));
      response.socket?.destroy();
      return;
    }

    const upstream = {
      status: upstreamResponse.status,
      responseBytes: upstreamBody.byteLength,
      responseSha256: sha256(upstreamBody),
      requestIdSha256: hashHeader(upstreamResponse.headers.get("x-request-id")),
    };
    const upstreamSucceeded = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
    if (rule?.action === "drop_after_upstream") {
      if (upstreamSucceeded) {
        record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
          upstreamReached: true, upstreamSucceeded, upstream, downstream: "connection_dropped", faultSatisfied: true }));
        response.socket?.destroy();
        return;
      }
      faultPreconditionFailure = "upstream_status_not_2xx";
    }

    let outgoingBody = upstreamBody;
    let downstream = rule ? "mutated_response" : "forwarded";
    let faultSatisfied = rule ? true : null;
    if (rule?.action === "partial_pagination_after_upstream") {
      try {
        const value = JSON.parse(upstreamBody.toString("utf8"));
        if (!upstreamSucceeded) faultPreconditionFailure = "upstream_status_not_2xx";
        else if (!upstreamRequestMutated) faultPreconditionFailure ??= "query_request_not_rewritten";
        else if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.results) ||
          value.results.length === 0 || value.has_more !== true || typeof value.next_cursor !== "string" ||
          value.next_cursor.length === 0) {
          faultPreconditionFailure = "upstream_did_not_return_a_followup_cursor";
        }
        if (faultPreconditionFailure === null) {
          counters.get(rule.id).awaitingPaginationFollowup = true;
          downstream = "partial_page_forwarded";
        } else {
          downstream = "forwarded_fault_precondition_failed";
          faultSatisfied = false;
        }
      } catch {
        faultPreconditionFailure = "upstream_response_not_json";
        downstream = "forwarded_fault_precondition_failed";
        faultSatisfied = false;
      }
    } else if (rule?.action === "schema_missing_properties_after_upstream") {
      try {
        const value = JSON.parse(upstreamBody.toString("utf8"));
        if (!upstreamSucceeded) faultPreconditionFailure = "upstream_status_not_2xx";
        else if (!value || typeof value !== "object" || Array.isArray(value)) {
          faultPreconditionFailure = "upstream_response_not_object";
        } else {
          value.properties = {};
          outgoingBody = Buffer.from(JSON.stringify(value));
        }
        if (faultPreconditionFailure !== null) {
          downstream = "forwarded_fault_precondition_failed";
          faultSatisfied = false;
        }
      } catch {
        faultPreconditionFailure = "upstream_response_not_json";
        downstream = "forwarded_fault_precondition_failed";
        faultSatisfied = false;
      }
    } else if (rule?.action === "drop_after_upstream") {
      downstream = "forwarded_fault_precondition_failed";
      faultSatisfied = false;
    }

    const headers = responseHeaders(upstreamResponse.headers, outgoingBody.byteLength);
    response.writeHead(upstreamResponse.status, headers);
    response.end(outgoingBody);
    record(evidencePath, evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule,
      upstreamReached: true, upstreamSucceeded, upstreamRequestMutated, upstream, downstream, faultSatisfied,
      failure: faultPreconditionFailure }));
  });
}

function evidence({ startedAt, method, path, authorizationPresent, notionVersion, requestBody, rule, upstreamReached,
  upstreamSucceeded, upstreamRequestMutated, upstream, downstream, retryAfter, failure, faultSatisfied }) {
  return {
    schemaVersion: 2,
    startedAt,
    finishedAt: new Date().toISOString(),
    method,
    pathTemplate: redactPath(path),
    requestBytes: requestBody.byteLength,
    requestSha256: sha256(requestBody),
    authorizationPresent,
    notionVersion,
    ruleId: rule?.id ?? null,
    action: rule?.action ?? "forward",
    faultPhase: rule?.phase ?? null,
    faultSatisfied: faultSatisfied ?? null,
    upstreamReached,
    upstreamSucceeded: upstreamSucceeded ?? null,
    upstreamRequestMutated: upstreamRequestMutated ?? false,
    upstreamStatus: upstream?.status ?? null,
    upstreamResponseBytes: upstream?.responseBytes ?? null,
    upstreamResponseSha256: upstream?.responseSha256 ?? null,
    upstreamRequestIdSha256: upstream?.requestIdSha256 ?? null,
    downstream,
    retryAfter: retryAfter ?? null,
    failure: failure ?? null,
  };
}

function selectRule(rules, counters, method, path) {
  for (const candidate of rules) {
    if (candidate.method !== method || !candidate.pattern.test(path)) continue;
    const counter = counters.get(candidate.id);
    counter.seen += 1;
    if (candidate.action === "partial_pagination_after_upstream" && counter.awaitingPaginationFollowup) {
      counter.awaitingPaginationFollowup = false;
      return { ...candidate, phase: "pagination_followup" };
    }
    if (counter.seen <= candidate.after || counter.applied >= candidate.times) continue;
    counter.applied += 1;
    return { ...candidate, phase: "primary" };
  }
  return undefined;
}

function forwardedHeaders(rawHeaders) {
  const headers = new Headers();
  const skipped = new Set(["connection", "content-length", "host", "transfer-encoding"]);
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (skipped.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function responseHeaders(upstreamHeaders, length) {
  const headers = {};
  const skipped = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
  for (const [name, value] of upstreamHeaders.entries()) if (!skipped.has(name.toLowerCase())) headers[name] = value;
  headers["content-length"] = String(length);
  return headers;
}

function readBody(stream, maximum) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        rejectBody(new Error("request_too_large"));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolveBody(Buffer.concat(chunks)));
    stream.on("error", rejectBody);
  });
}

function injectedError(status) {
  const code = status === 429 ? "rate_limited" : status === 403 ? "restricted_resource"
    : status === 404 ? "object_not_found" : "service_unavailable";
  return { object: "error", status, code, message: "Injected by the local NewDay acceptance proxy" };
}

function redactPath(path) {
  return path.split("/").map((part) => /^[A-Za-z0-9_-]{16,}$/.test(part) ? ":id" : part).join("/");
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function hashHeader(value) { return value ? sha256(Buffer.from(value)).slice(0, 16) : null; }

function prepareEvidence(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function record(path, value) { appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

function parseRules(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.rules) || value.rules.length > 50) {
    throw new Error("Rules must use schemaVersion 1 and contain at most 50 rules");
  }
  const ids = new Set();
  return value.rules.map((raw) => {
    if (!raw || typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.id) || ids.has(raw.id)) {
      throw new Error("Every rule needs a unique safe id");
    }
    ids.add(raw.id);
    if (typeof raw.method !== "string" || !["GET", "POST", "PATCH"].includes(raw.method.toUpperCase())) {
      throw new Error(`Rule ${raw.id} has an unsupported method`);
    }
    if (typeof raw.pathPattern !== "string" || raw.pathPattern.length > 240 ||
      !raw.pathPattern.startsWith("^") || !raw.pathPattern.endsWith("$")) {
      throw new Error(`Rule ${raw.id} needs a bounded, anchored pathPattern`);
    }
    if (!allowedActions.has(raw.action)) throw new Error(`Rule ${raw.id} has an unsupported action`);
    const method = raw.method.toUpperCase();
    if (raw.action === "partial_pagination_after_upstream" && method !== "POST") {
      throw new Error(`Rule ${raw.id} must use POST for partial pagination`);
    }
    if (raw.action === "drop_after_upstream" && method !== "POST" && method !== "PATCH") {
      throw new Error(`Rule ${raw.id} must target a POST or PATCH write`);
    }
    const times = raw.times ?? 1;
    if (!Number.isInteger(times) || times < 1 || times > 20) throw new Error(`Rule ${raw.id} has invalid times`);
    const after = raw.after ?? 0;
    if (!Number.isInteger(after) || after < 0 || after > 50) throw new Error(`Rule ${raw.id} has invalid after count`);
    if (raw.action === "respond_status" && ![403, 404, 429, 529].includes(raw.status)) {
      throw new Error(`Rule ${raw.id} has invalid injected status`);
    }
    if (raw.retryAfter !== undefined && (typeof raw.retryAfter !== "string" || raw.retryAfter.length > 80)) {
      throw new Error(`Rule ${raw.id} has invalid Retry-After`);
    }
    return { id: raw.id, method, pattern: new RegExp(raw.pathPattern),
      action: raw.action, times, after, status: raw.status, retryAfter: raw.retryAfter };
  });
}

function parseArgs(argv) {
  const result = { port: 3012 };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--port" && value && /^\d+$/.test(value)) { result.port = Number(value); index += 1; }
    else if (name === "--rules" && value) { result.rulesPath = resolve(value); index += 1; }
    else if (name === "--evidence" && value) { result.evidencePath = resolve(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${name}`);
  }
  if (!result.rulesPath || !result.evidencePath || result.port < 1 || result.port > 65_535) {
    throw new Error("Usage: notion-live-fault-proxy.mjs --rules FILE --evidence FILE [--port 3012]");
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));
  const rules = parseRules(options.rulesPath);
  const server = createNotionFaultProxy({ rules, evidencePath: options.evidencePath });
  server.listen(options.port, "127.0.0.1", () => {
    console.log(JSON.stringify({ event: "notion_acceptance_proxy_ready", host: "127.0.0.1",
      port: options.port, upstream: UPSTREAM_ORIGIN, ruleIds: rules.map((rule) => rule.id) }));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
}
