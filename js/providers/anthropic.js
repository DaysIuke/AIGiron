// providers/anthropic.js — Anthropic Messages API のアダプタ。
// system は独立フィールド、max_tokens は必須、認証は x-api-key（BD §5.4）。

import { normalizeError, resolveRetrySec, maskKey } from "../errors.js";

export const anthropicAdapter = {
  buildRequest({ def, agent, ctx, apiKey, maxTokens, json }) {
    const url = def.origin + def.path;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey ?? "",
      ...(def.extraHeaders ?? {})
    };

    const body = {
      model: agent.model,
      max_tokens: maxTokens,        // Anthropic では必須
      system: ctx.system,
      messages: [{ role: "user", content: ctx.user }]
    };
    // JSON 強制は TBD-01（Phase 2 で tool_use か検討）。ここではプロンプトに任せる。

    return { url, init: { method: "POST", headers, body: JSON.stringify(body) } };
  },

  extractText: (j) =>
    (j?.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join(""),

  // max_tokens が OpenAI の "length" に相当。統一して返す（D-020 が同じ経路で効く）。
  extractFinishReason: (j) => {
    const r = j?.stop_reason ?? null;
    if (r === "max_tokens") return "length";
    if (r === "end_turn" || r === "stop_sequence") return "stop";
    return r ? String(r).toLowerCase() : null;
  },

  extractUsage: (j) => ({
    tokensIn: j?.usage?.input_tokens ?? null,
    tokensOut: j?.usage?.output_tokens ?? null
  }),

  describeEmpty: (j) =>
    "空応答（stop_reason: " + (j?.stop_reason ?? "不明") + "）",

  // エラーは { type:"error", error:{ type, message } } の形
  parseError: (status, headers, body, provider) => {
    const base = normalizeError(status, headers, body, provider);
    try {
      const j = JSON.parse(body);
      const msg = j?.error?.message;
      if (msg) base.message = maskKey(msg);
      // 一部のレート応答は error.type === "rate_limit_error"
      if (j?.error?.type === "rate_limit_error") base.kind = "rate";
      if (j?.error?.type === "authentication_error") base.kind = "auth";
    } catch { /* 既定の解釈のまま */ }
    return { ...base, retryAfterSec: resolveRetrySec(status, headers, body) };
  },

  capabilities: { json: false, stream: true }
};
