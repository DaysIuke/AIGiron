// providers/openai-compat.js — OpenAI互換の Chat Completions アダプタ。
// Groq / Cerebras / Mistral / OpenRouter / OpenAI が同じ形をしている。

import { normalizeError, resolveRetrySec } from "../errors.js";

// D-024: gpt-oss は思考トークンを先に出す。既定の思考量だと出力枠を思考だけで使い切り、
//   本文が0文字のまま finish_reason:"length" で返ってくる。
//   reasoning_effort を絞り、思考本文の返送も止めて枠を本文に回す。
const REASONING_MODELS = /gpt-oss|^o[13]-|qwen3/i;

export function isReasoningModel(modelId) {
  return REASONING_MODELS.test(String(modelId ?? ""));
}

export const openaiCompatAdapter = {
  buildRequest({ def, agent, ctx, apiKey, maxTokens, json, reasoningEffort }) {
    const url = def.origin + def.path.replace("{model}", encodeURIComponent(agent.model));
    const headers = { "Content-Type": "application/json", ...(def.extraHeaders ?? {}) };
    if (def.auth === "bearer") headers["Authorization"] = "Bearer " + (apiKey ?? "");

    const body = {
      model: agent.model,
      messages: [
        { role: "system", content: ctx.system },
        { role: "user", content: ctx.user }
      ],
      max_tokens: maxTokens
    };
    if (json) body.response_format = { type: "json_object" };

    if (isReasoningModel(agent.model)) {
      body.reasoning_effort = reasoningEffort ?? "low";
      body.include_reasoning = false;
    }

    return { url, init: { method: "POST", headers, body: JSON.stringify(body) } };
  },

  // content は文字列とは限らない（D-061）。一部の OpenAI 互換実装は
  //   [{ type:"text", text:"…" }] の配列で返す。文字列前提で扱うと共通経路の
  //   text.trim() で落ち、**正常な応答なのに発言が失われて離脱**まで進む。
  //   null（tool_calls 併用時）は空扱いのままでよい。
  extractText: (j) => {
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
    }
    return c == null ? "" : String(c);
  },

  // "length" なら出力上限で打ち切られている（D-020）
  extractFinishReason: (j) => j?.choices?.[0]?.finish_reason ?? null,

  extractUsage: (j) => ({
    tokensIn: j?.usage?.prompt_tokens ?? null,
    tokensOut: j?.usage?.completion_tokens ?? null
  }),

  describeEmpty: (j) =>
    `空応答（finish_reason: ${j?.choices?.[0]?.finish_reason ?? "不明"}）`,

  parseError: (status, headers, body, provider) => ({
    ...normalizeError(status, headers, body, provider),
    retryAfterSec: resolveRetrySec(status, headers, body)
  }),

  capabilities: { json: true, stream: true }
};
