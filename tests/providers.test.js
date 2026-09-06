// tests/providers.test.js — プロバイダ共通経路とモックの故障モード。
// モックは実プロバイダと同じ経路（callProvider → fetchCombined）を通る。

import { group, atest, eq, ok } from "./runner.js";
import { callProvider, isChatModel, listModels, ADAPTERS } from "../js/providers/index.js";
import { setMockConfig } from "../js/providers/mock.js";
import { openaiCompatAdapter, isReasoningModel } from "../js/providers/openai-compat.js";
import { PROVIDERS, makeAgent } from "../js/config.js";

const agent = makeAgent(0, "mock", "mock-fast", "モック");
const ctx = { system: "あなたは参加者です。", user: "【議題】テスト" };

async function callAndCatch(opts = {}) {
  try {
    const res = await callProvider(agent, ctx, opts);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, err: e };
  }
}

export async function run() {
  group("providers 共通経路とモック");

  await atest("P-1 正常時はテキストと usage が返る", async () => {
    setMockConfig({ failMode: null, delayMs: 0 });
    const r = await callAndCatch();
    ok(r.ok, "正常応答が失敗した");
    ok(r.res.text.length > 0, "本文が空");
    ok(r.res.usage.tokensOut > 0, "usage が取れていない");
  });

  await atest("P-2 429 は kind:rate になる", async () => {
    setMockConfig({ failMode: "429" });
    const r = await callAndCatch();
    ok(!r.ok, "429 なのに成功扱い");
    eq(r.err.kind, "rate");
    eq(r.err.status, 429);
  });

  await atest("P-3 500 は kind:server になる", async () => {
    setMockConfig({ failMode: "500" });
    const r = await callAndCatch();
    eq(r.err.kind, "server");
  });

  await atest("P-4 無応答は kind:timeout になる（AbortSignal 合成）", async () => {
    setMockConfig({ failMode: "timeout" });
    const r = await callAndCatch({ timeoutMs: 30 });
    eq(r.err.kind, "timeout");
  });

  await atest("P-5 200 だが本文が空なら kind:empty（RB-M1）", async () => {
    setMockConfig({ failMode: "empty" });
    const r = await callAndCatch();
    eq(r.err.kind, "empty");
    ok(r.err.message.includes("content_filter"), "空応答の理由が入っていない");
  });

  await atest("P-6 外部からの中断は kind:aborted で、timeout と区別される", async () => {
    setMockConfig({ failMode: "timeout" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await callAndCatch({ signal: ac.signal, timeoutMs: 5000 });
    eq(r.err.kind, "aborted");
  });

  await atest("P-7 スクリプト混入応答も素の文字列として返る（AC-A17）", async () => {
    setMockConfig({ failMode: "xss" });
    const r = await callAndCatch();
    ok(r.ok, "xss モードは 200 応答のはず");
    ok(r.res.text.includes("<script>"), "本文が改変されている");
    ok(typeof r.res.text === "string", "文字列以外が返った");
  });

  await atest("P-8 エラー本文のAPIキーはマスクされる（AC-A16）", async () => {
    setMockConfig({ failMode: "leak" });
    const r = await callAndCatch();
    eq(r.err.kind, "auth");
    ok(!r.err.message.includes("testkey"), "エラーメッセージにキーが残っている: " + r.err.message);
    ok(r.err.message.includes("***"), "マスクされていない");
  });

  await atest("P-8b 出力上限で切れた応答は finishReason で判別できる（D-020）", async () => {
    setMockConfig({ failMode: "truncated" });
    const r = await callAndCatch();
    ok(r.ok, "200 応答なので成功扱いのはず");
    eq(r.res.finishReason, "length");
    setMockConfig({ failMode: null });
    const ok2 = await callAndCatch();
    eq(ok2.res.finishReason, "stop", "正常時は stop であるべき");
  });

  await atest("P-8c 思考で枠を使い切った空応答は kind:budget（D-024）", async () => {
    setMockConfig({ failMode: "budget" });
    const r = await callAndCatch();
    eq(r.err.kind, "budget", "empty と区別されていない");
    setMockConfig({ failMode: "empty" });
    const r2 = await callAndCatch();
    eq(r2.err.kind, "empty", "通常の空応答まで budget になっている");
    setMockConfig({ failMode: null });
  });

  await atest("P-8d 推論モデルには reasoning_effort を付ける（D-024）", async () => {
    for (const id of ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen3-32b"]) {
      ok(isReasoningModel(id), "推論モデルと判定されない: " + id);
    }
    for (const id of ["llama-3.3-70b-versatile", "mistral-small-latest"]) {
      ok(!isReasoningModel(id), "誤って推論モデル扱い: " + id);
    }
    const a = makeAgent(0, "groq", "openai/gpt-oss-20b", "G");
    const { init } = openaiCompatAdapter.buildRequest({
      def: PROVIDERS.groq, agent: a, ctx, apiKey: "k", maxTokens: 500
    });
    const body = JSON.parse(init.body);
    eq(body.reasoning_effort, "low");
    eq(body.include_reasoning, false);

    const b = makeAgent(0, "groq", "llama-3.3-70b-versatile", "L");
    const plain = JSON.parse(openaiCompatAdapter.buildRequest({
      def: PROVIDERS.groq, agent: b, ctx, apiKey: "k", maxTokens: 500
    }).init.body);
    eq(plain.reasoning_effort, undefined, "非推論モデルに余計なパラメータを送っている");
  });

  await atest("P-9 budget は成功・失敗を問わず fetch 発行時に加算される（RB-C4）", async () => {
    let consumed = 0;
    const budget = { check() {}, consume() { consumed++; } };

    setMockConfig({ failMode: null });
    await callAndCatch({ budget });
    setMockConfig({ failMode: "500" });
    await callAndCatch({ budget });

    eq(consumed, 2, "失敗した分が数えられていない");
  });

  await atest("P-10 budget.check が投げると fetch 前に止まる", async () => {
    let consumed = 0;
    const budget = {
      check() { throw { kind: "limit", message: "上限" }; },
      consume() { consumed++; }
    };
    setMockConfig({ failMode: null });
    const r = await callAndCatch({ budget });
    eq(r.err.kind, "limit");
    eq(consumed, 0, "上限超過なのに消費された");
  });

  group("providers/openai-compat.js リクエスト組み立て");

  await atest("P-11 URL はオリジンとパスから組み立てられ、キーはヘッダに載る", async () => {
    const a = makeAgent(0, "groq", "llama-3.3-70b-versatile", "Groq");
    const { url, init } = openaiCompatAdapter.buildRequest({
      def: PROVIDERS.groq, agent: a, ctx, apiKey: "sk-secret12345678", maxTokens: 800
    });
    eq(url, "https://api.groq.com/openai/v1/chat/completions");
    eq(init.headers["Authorization"], "Bearer sk-secret12345678");
    ok(!url.includes("sk-secret"), "URLにキーが載っている");

    const body = JSON.parse(init.body);
    eq(body.model, "llama-3.3-70b-versatile");
    eq(body.messages[0].role, "system");
    eq(body.messages[1].role, "user");
    eq(body.max_tokens, 800);
  });

  await atest("P-12 json 指定で response_format が付く", async () => {
    const a = makeAgent(0, "groq", "llama-3.3-70b-versatile", "Groq");
    const { init } = openaiCompatAdapter.buildRequest({
      def: PROVIDERS.groq, agent: a, ctx, apiKey: "k", maxTokens: 100, json: true
    });
    eq(JSON.parse(init.body).response_format, { type: "json_object" });
  });

  await atest("P-13 モデル名は URL エンコードされる", async () => {
    const def = { ...PROVIDERS.gemini };
    const a = makeAgent(0, "gemini", "gemini-2.5-flash", "G");
    const url = def.origin + def.path.replace("{model}", encodeURIComponent(a.model));
    ok(url.endsWith("/v1beta/models/gemini-2.5-flash:generateContent"), "URL 組み立てが違う: " + url);
  });

  await atest("P-13b 議論に使えないモデルを除外する（D-016）", async () => {
    // Groq が実際に返す種類を模した ID
    const nonChat = [
      "whisper-large-v3", "whisper-large-v3-turbo", "distil-whisper-large-v3-en",
      "playai-tts", "canopylabs/orpheus-3b-0.1-ft",
      "meta-llama/llama-prompt-guard-2-22m", "meta-llama/llama-guard-4-12b",
      "text-embedding-3-small"
    ];
    for (const id of nonChat) ok(!isChatModel(id), "除外できていない: " + id);

    const chat = [
      "openai/gpt-oss-120b", "openai/gpt-oss-20b",
      "groq/compound", "groq/compound-mini", "qwen3-32b"
    ];
    for (const id of chat) ok(isChatModel(id), "誤って除外した: " + id);
  });

  await atest("P-15 モデル一覧のページ分割を辿る（レビュー #6）", async () => {
    const gPages = [
      { models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000 }],
        nextPageToken: "T2" },
      { models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 2000 }] }
    ];
    let gCalls = 0;
    const gFetch = async (url) => {
      const page = url.includes("pageToken") ? gPages[1] : gPages[0];
      gCalls++;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) };
    };
    const gList = await listModels("gemini", "k", { fetchImpl: gFetch });
    eq(gCalls, 2, "次ページを取得していない");
    eq(gList.map((m) => m.id).sort(), ["gemini-a", "gemini-b"]);

    const aPages = [
      { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
      { data: [{ id: "claude-b" }], has_more: false }
    ];
    let aCalls = 0;
    const aFetch = async (url) => {
      const page = url.includes("after_id") ? aPages[1] : aPages[0];
      aCalls++;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) };
    };
    const aList = await listModels("anthropic", "k", { fetchImpl: aFetch });
    eq(aCalls, 2);
    eq(aList.map((m) => m.id).sort(), ["claude-a", "claude-b"]);
  });

  // D-061: content は文字列とは限らない。配列で返す OpenAI 互換実装があり、
  //   文字列前提のままだと共通経路の text.trim() で落ち、正常な応答なのに
  //   発言が失われて離脱まで進んでいた。
  await atest("P-19 openai互換の content が配列でも本文を取り出せる（D-061）", async () => {
    eq(openaiCompatAdapter.extractText({
      choices: [{ message: { content: [{ type: "text", text: "前半" }, { type: "text", text: "後半" }] } }]
    }), "前半後半");
    eq(openaiCompatAdapter.extractText({
      choices: [{ message: { content: ["素の", "文字列配列"] } }]
    }), "素の文字列配列", "文字列の配列も連結できるべき");
  });

  await atest("P-20 content が null / 数値 / 欠落でも落ちない（D-061）", async () => {
    eq(openaiCompatAdapter.extractText({ choices: [{ message: { content: null } }] }), "",
      "null は空扱い（tool_calls 併用時）");
    eq(openaiCompatAdapter.extractText({ choices: [{ message: {} }] }), "");
    eq(openaiCompatAdapter.extractText({ choices: [] }), "");
    eq(openaiCompatAdapter.extractText({}), "");
    eq(openaiCompatAdapter.extractText({ choices: [{ message: { content: 12345 } }] }), "12345",
      "数値は文字列に潰す");
  });

  await atest("P-21 openai互換の配列 content が共通経路でも本文として通る（D-061）", async () => {
    const saved = PROVIDERS.groq.fetchImpl;
    PROVIDERS.groq.fetchImpl = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "配列本文" }] },
                                                    finish_reason: "stop" }] })
    });
    try {
      const res = await callProvider(makeAgent(0, "groq", "m", "A"),
        { system: "s", user: "u" }, { getKey: () => "k" });
      eq(res.text, "配列本文", "共通経路で本文が失われている");
    } finally {
      PROVIDERS.groq.fetchImpl = saved;
    }
  });

  await atest("P-22 アダプタが文字列以外を返したら空扱いにする（発言に混入させない・D-061）", async () => {
    // 最後の防波堤。String() で潰すと "[object Object]" が発言として残ってしまうため、
    // 空応答として既存の再試行・失敗計上の経路に乗せる。
    const savedImpl = PROVIDERS.mock.fetchImpl;
    const savedExtract = ADAPTERS.mock.extractText;
    PROVIDERS.mock.fetchImpl = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })
    });
    ADAPTERS.mock.extractText = () => ({ 壊れた: "形" });   // 文字列でない値を返すアダプタ
    try {
      let kind = null;
      try {
        await callProvider(makeAgent(0, "mock", "mock-fast", "A"),
          { system: "s", user: "u" }, { getKey: () => "" });
      } catch (e) { kind = e?.kind; }
      eq(kind, "empty", "空応答として扱われていない（[object Object] が混入する恐れ）");
    } finally {
      PROVIDERS.mock.fetchImpl = savedImpl;
      ADAPTERS.mock.extractText = savedExtract;
    }
  });

  await atest("P-14 Cerebras は CORS 不成立のため無効のまま（VF-04）", async () => {
    eq(PROVIDERS.cerebras.enabled, false);
    eq(PROVIDERS.cerebras.corsBroken, true);
  });

  await atest("P-16 failTimes:0 は failMode で失敗し続ける（既定・IMPL §3-3）", async () => {
    setMockConfig({ failMode: "429", failTimes: 0 });
    for (let i = 0; i < 3; i++) {
      const r = await callAndCatch();
      eq(r.ok, false, i + "回目で成功してしまった");
      eq(r.err.kind, "rate");
    }
  });

  await atest("P-17 failTimes:N はN回失敗してから正常応答に戻る（AC-A06 の再現手段・IMPL §3-1）", async () => {
    setMockConfig({ failMode: "429", failTimes: 2 });
    const r1 = await callAndCatch();
    eq(r1.ok, false, "1回目は失敗するはず");
    const r2 = await callAndCatch();
    eq(r2.ok, false, "2回目も失敗するはず");
    const r3 = await callAndCatch();
    ok(r3.ok, "3回目（failTimes消費後）は成功するはず");
    const r4 = await callAndCatch();
    ok(r4.ok, "4回目も成功が続くはず");
  });

  await atest("P-18 setMockConfig で failTimes を再指定すると数え直す", async () => {
    setMockConfig({ failMode: "500", failTimes: 1 });
    const r1 = await callAndCatch();
    eq(r1.ok, false);
    const r2 = await callAndCatch();
    ok(r2.ok, "1回消費後は成功するはず");
    // 同じ failMode のまま failTimes を再指定 → カウンタが1に戻るはず
    setMockConfig({ failTimes: 1 });
    const r3 = await callAndCatch();
    eq(r3.ok, false, "failTimes 再指定でカウンタが復活していない");
    const r4 = await callAndCatch();
    ok(r4.ok);
  });

  // 後片付け
  setMockConfig({ failMode: null, delayMs: 0, failTimes: 0 });
}
