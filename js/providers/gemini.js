// providers/gemini.js — Google Gemini の generateContent アダプタ。
// OpenAI 互換とは本文・応答・認証・429 の形がすべて違う（BD §5.4）。

import { normalizeError, resolveRetrySec } from "../errors.js";

export const geminiAdapter = {
  buildRequest({ def, agent, ctx, apiKey, maxTokens, json, reasoningEffort }) {
    const url = def.origin + def.path.replace("{model}", encodeURIComponent(agent.model));
    const headers = {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey ?? "",
      ...(def.extraHeaders ?? {})
    };

    const generationConfig = { maxOutputTokens: maxTokens };
    if (json) generationConfig.responseMimeType = "application/json";

    // D-025 / D-027: 思考モデルの思考量を絞る。世代で指定方法が違う。
    //   3 系: thinkingLevel（low / medium / high）。思考オフは不可
    //   2.5 系: thinkingBudget（トークン数）。0 で思考オフ（pro は最小 128）
    const effort = reasoningEffort ?? "low";
    if (/gemini-3/i.test(agent.model)) {
      generationConfig.thinkingConfig = { thinkingLevel: effort };
    } else if (/gemini-2\.5/i.test(agent.model)) {
      const isPro = /pro/i.test(agent.model);
      const budget = { low: isPro ? 128 : 0, medium: 1024, high: 4096 }[effort] ?? 0;
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }

    const body = {
      systemInstruction: { parts: [{ text: ctx.system }] },
      contents: [{ role: "user", parts: [{ text: ctx.user }] }],
      generationConfig
    };

    return { url, init: { method: "POST", headers, body: JSON.stringify(body) } };
  },

  extractText: (j) =>
    (j?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p?.text ?? "")
      .join(""),

  // MAX_TOKENS が OpenAI の "length" に相当する。統一して返す（D-020 が同じ経路で効く）。
  extractFinishReason: (j) => {
    const r = j?.candidates?.[0]?.finishReason ?? null;
    if (r === "MAX_TOKENS") return "length";
    if (r === "STOP") return "stop";
    return r ? String(r).toLowerCase() : null;
  },

  extractUsage: (j) => ({
    tokensIn: j?.usageMetadata?.promptTokenCount ?? null,
    tokensOut: j?.usageMetadata?.candidatesTokenCount ?? null
  }),

  // 安全フィルタで落ちた場合は candidates が空で promptFeedback.blockReason が入る
  describeEmpty: (j) => {
    const block = j?.promptFeedback?.blockReason;
    if (block) return "空応答（安全フィルタ: " + block + "）";
    return "空応答（finishReason: " + (j?.candidates?.[0]?.finishReason ?? "不明") + "）";
  },

  parseError: (status, headers, body, provider) => ({
    ...normalizeError(status, headers, body, provider),
    retryAfterSec: resolveRetrySec(status, headers, body)   // ② RetryInfo.retryDelay を読む
  }),

  capabilities: { json: true, stream: true }
};
