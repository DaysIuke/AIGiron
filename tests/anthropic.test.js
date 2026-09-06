// tests/anthropic.test.js — Anthropic アダプタ。

import { group, atest, eq, ok } from "./runner.js";
import { anthropicAdapter } from "../js/providers/anthropic.js";
import { PROVIDERS, makeAgent } from "../js/config.js";

const ctx = { system: "あなたは参加者です。", user: "【議題】テスト" };
const H = { get: () => null };

export async function run() {
  group("providers/anthropic.js Anthropic アダプタ");

  await atest("AN-1 リクエストの形が Messages API になっている", async () => {
    const a = makeAgent(0, "anthropic", "claude-haiku-4-5-20251001", "クロード");
    const { url, init } = anthropicAdapter.buildRequest({
      def: PROVIDERS.anthropic, agent: a, ctx, apiKey: "sk-ant-test12345678", maxTokens: 500
    });
    eq(url, "https://api.anthropic.com/v1/messages");
    eq(init.headers["x-api-key"], "sk-ant-test12345678");
    eq(init.headers["anthropic-version"], "2023-06-01");
    eq(init.headers["anthropic-dangerous-direct-browser-access"], "true");
    ok(!("Authorization" in init.headers), "Bearer を送っている");

    const body = JSON.parse(init.body);
    eq(body.system, ctx.system, "system が独立フィールドでない");
    eq(body.messages, [{ role: "user", content: ctx.user }]);
    eq(body.max_tokens, 500, "max_tokens は必須");
  });

  await atest("AN-2 content ブロックから text だけを連結する", async () => {
    const j = { content: [{ type: "text", text: "前半" }, { type: "tool_use" }, { type: "text", text: "後半" }],
                stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } };
    eq(anthropicAdapter.extractText(j), "前半後半");
    eq(anthropicAdapter.extractFinishReason(j), "stop");
    eq(anthropicAdapter.extractUsage(j), { tokensIn: 10, tokensOut: 20 });
  });

  await atest("AN-3 max_tokens 打ち切りは length に正規化（D-020 が効く）", async () => {
    eq(anthropicAdapter.extractFinishReason({ stop_reason: "max_tokens" }), "length");
  });

  await atest("AN-4 エラー本文の型からも kind を判定し、キーを漏らさない", async () => {
    const rate = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } });
    eq(anthropicAdapter.parseError(429, H, rate, "anthropic").kind, "rate");

    const auth = JSON.stringify({ type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key sk-ant-leaked1234567890" } });
    const e = anthropicAdapter.parseError(401, H, auth, "anthropic");
    eq(e.kind, "auth");
    ok(!e.message.includes("sk-ant-leaked"), "キーが残っている: " + e.message);
  });
}
