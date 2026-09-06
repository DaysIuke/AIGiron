// tests/gemini.test.js — Gemini アダプタ。OpenAI 互換との差分を検証する。

import { group, atest, eq, ok } from "./runner.js";
import { geminiAdapter } from "../js/providers/gemini.js";
import { PROVIDERS, makeAgent, DEFAULTS } from "../js/config.js";
import { resolveRetrySec } from "../js/errors.js";
import { callProvider } from "../js/providers/index.js";
import { createEngine } from "../js/engine.js";
import { createFakeClock } from "../js/clock.js";
import { resetState } from "../js/state.js";

const ctx = { system: "あなたは参加者です。", user: "【議題】テスト" };
const H = { get: () => null };

export async function run() {
  group("providers/gemini.js Gemini アダプタ");

  await atest("GM-1 URL・認証ヘッダ・本文の形が Gemini 仕様になっている", async () => {
    const a = makeAgent(0, "gemini", "gemini-2.5-flash", "G");
    const { url, init } = geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: a, ctx, apiKey: "AIzaSyTESTKEY1234567890", maxTokens: 500
    });
    eq(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    eq(init.headers["x-goog-api-key"], "AIzaSyTESTKEY1234567890");
    ok(!url.includes("AIza"), "URL にキーが載っている");
    ok(!("Authorization" in init.headers), "Bearer を送っている");

    const body = JSON.parse(init.body);
    eq(body.systemInstruction.parts[0].text, ctx.system);
    eq(body.contents[0].role, "user");
    eq(body.contents[0].parts[0].text, ctx.user);
    eq(body.generationConfig.maxOutputTokens, 500);
    ok(!("messages" in body), "OpenAI 形式の messages を送っている");
  });

  await atest("GM-2 2.5 系には thinkingBudget が付き、low なら flash は 0・pro は 128（D-025）", async () => {
    const flash = makeAgent(0, "gemini", "gemini-2.5-flash", "F");
    const pro = makeAgent(1, "gemini", "gemini-2.5-pro", "P");
    const bf = JSON.parse(geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: flash, ctx, apiKey: "k", maxTokens: 500, reasoningEffort: "low"
    }).init.body);
    const bp = JSON.parse(geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: pro, ctx, apiKey: "k", maxTokens: 500, reasoningEffort: "low"
    }).init.body);
    eq(bf.generationConfig.thinkingConfig.thinkingBudget, 0);
    eq(bp.generationConfig.thinkingConfig.thinkingBudget, 128);

    const bh = JSON.parse(geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: flash, ctx, apiKey: "k", maxTokens: 500, reasoningEffort: "high"
    }).init.body);
    eq(bh.generationConfig.thinkingConfig.thinkingBudget, 4096);
  });

  await atest("GM-3 応答の parts を連結して本文にする", async () => {
    const j = { candidates: [{ content: { parts: [{ text: "前半" }, { text: "後半" }] }, finishReason: "STOP" }] };
    eq(geminiAdapter.extractText(j), "前半後半");
    eq(geminiAdapter.extractFinishReason(j), "stop");
  });

  await atest("GM-4 MAX_TOKENS は length に正規化される（D-020 が同じ経路で効く）", async () => {
    const j = { candidates: [{ content: { parts: [{ text: "途中" }] }, finishReason: "MAX_TOKENS" }] };
    eq(geminiAdapter.extractFinishReason(j), "length");
  });

  await atest("GM-5 安全フィルタで落ちた空応答は理由が分かる", async () => {
    const j = { promptFeedback: { blockReason: "SAFETY" }, candidates: [] };
    eq(geminiAdapter.extractText(j), "");
    ok(geminiAdapter.describeEmpty(j).includes("SAFETY"), "blockReason が出ていない");
  });

  await atest("GM-6 usage は usageMetadata から取る", async () => {
    const j = { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 } };
    eq(geminiAdapter.extractUsage(j), { tokensIn: 120, tokensOut: 80 });
  });

  await atest("GM-7 429 の RetryInfo.retryDelay を待機秒数として読む（EIF-04 ②）", async () => {
    const body = JSON.stringify({
      error: {
        code: 429, status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" }
        ]
      }
    });
    const e = geminiAdapter.parseError(429, H, body, "gemini");
    eq(e.kind, "rate");
    eq(e.retryAfterSec, 41);
    ok(e.message.includes("quota"), "本文のメッセージが取れていない");
    // 直接も確認
    eq(resolveRetrySec(429, H, body), 41);
  });

  await atest("GM-8 キーが不正なら auth。メッセージからキーを漏らさない", async () => {
    const body = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT",
      message: "API key not valid. Please pass a valid API key. AIzaSyLEAKEDKEY1234567890" } });
    // Gemini はキー不正で 400 INVALID_ARGUMENT を返す。config に落とさず auth にする（D-026）
    const e400 = geminiAdapter.parseError(400, H, body, "gemini");
    eq(e400.kind, "auth", "400 でも本文からキー不正と判定すべき");
    ok(!e400.message.includes("AIzaSyLEAKED"), "キーが残っている: " + e400.message);
    const e403 = geminiAdapter.parseError(403, H, body, "gemini");
    eq(e403.kind, "auth");
  });

  await atest("GM-10 3 系は thinkingLevel、2.5 系は thinkingBudget（D-027）", async () => {
    const g3 = makeAgent(0, "gemini", "gemini-3.6-flash", "G3");
    const b3 = JSON.parse(geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: g3, ctx, apiKey: "k", maxTokens: 500, reasoningEffort: "low"
    }).init.body);
    eq(b3.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    ok(!("thinkingBudget" in b3.generationConfig.thinkingConfig), "3 系に thinkingBudget を送っている");

    const lite = makeAgent(1, "gemini", "gemini-3.5-flash-lite", "L");
    const bl = JSON.parse(geminiAdapter.buildRequest({
      def: PROVIDERS.gemini, agent: lite, ctx, apiKey: "k", maxTokens: 500, reasoningEffort: "medium"
    }).init.body);
    eq(bl.generationConfig.thinkingConfig, { thinkingLevel: "medium" });
  });

  await atest("GM-11 提供終了の案内から後継モデル名を取り出す（D-028）", async () => {
    const body = JSON.stringify({ error: { code: 404, status: "NOT_FOUND",
      message: "This model models/gemini-2.5-flash is no longer available to new users. " +
               "Please update your code to use models/gemini-3.6-flash for the latest features and improvements." } });
    const e = geminiAdapter.parseError(404, H, body, "gemini");
    eq(e.kind, "config");
    eq(e.replacementModel, "gemini-3.6-flash");
  });

  await atest("GM-9 Gemini は無効化されていない（Phase 1b で有効化）", async () => {
    eq(PROVIDERS.gemini.enabled, true);
    eq(PROVIDERS.gemini.adapter, "gemini");
  });

  // AC-M03 の自動化。GM-7 はアダプタの parseError までしか見ておらず、
  // 「エンジンがその秒数だけ待って同じターンを再実行する」ところが未検証だった。
  // 実 Gemini の 429 は任意に再現できないため、gemini アダプタと実 callProvider は
  // そのまま通し、fetchImpl だけ差し替えて本物の 429 応答本文を返させる。
  await atest("GM-12 Gemini の 429 応答から retryDelay を読み、その秒数を待って同じターンを再実行する（AC-M03）", async () => {
    const body429 = JSON.stringify({
      error: {
        code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" }]
      }
    });
    const okBody = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "検証用の発言です。" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
    });

    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      const first = calls === 1;
      return {
        ok: !first,
        status: first ? 429 : 200,
        headers: { get: () => null },
        text: async () => (first ? body429 : okBody)
      };
    };

    const saved = PROVIDERS.gemini.fetchImpl;
    PROVIDERS.gemini.fetchImpl = fakeFetch;
    try {
      resetState();
      const clock = createFakeClock();
      const engine = createEngine({
        callProvider, storage: { save: async () => {} }, clock, getKey: () => "AIzaSyTESTKEY1234567890"
      });
      // 参加AIが1体だと isUnrecoverable が即座に成立してフェッチまで届かないため2体にする
      const agents = [makeAgent(0, "gemini", "gemini-2.5-flash", "G1"),
                      makeAgent(1, "gemini", "gemini-2.5-flash", "G2")];
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents, rounds: 1, enableSummaryRound: false, order: "fixed",
                  requestLimit: 10, maxWaitSec: 60 },
        seed: 1
      });

      // 1回目=429、2回目=G1の張り直し、3回目=G2
      eq(calls, 3, "429 のあとに同じターンを張り直していない");
      // D-017: API が指示した秒数を切り上げ、境界を避けるため +1 する（41 → 42）。
      //   指数バックオフ（2/4/8/16）ではなく API の指示に従っていることの確認でもある。
      eq(clock.slept, [42], "retryDelay(41s) に従った待機になっていない: " + JSON.stringify(clock.slept));
      eq(r.status, "done");
      eq(r.session.turns.length, 2, "再試行後の発言が確定していない");
      eq(r.session.requestCount, 3, "失敗した1回も requestCount に入るべき（RB-C4）");
    } finally {
      PROVIDERS.gemini.fetchImpl = saved;
    }
  });
}
