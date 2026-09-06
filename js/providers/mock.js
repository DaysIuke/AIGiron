// providers/mock.js — モックプロバイダ。
// 実プロバイダと同じ4点を実装し、fetch だけを差し替える（IMPL T-03 / 決定ログ D-004）。

import { normalizeError, resolveRetrySec } from "../errors.js";

// failTimes: 0 は「常に failMode で失敗し続ける」（従来の挙動）。
//   1以上を指定すると、その回数だけ failMode で失敗してから正常応答に戻る。
//   IMPL §3-1/§3-3。AC-A06（429で待機後に自動再開）等、"失敗して回復する" シナリオを
//   実キー無しで再現できるようにする。
export const mockConfig = { failMode: null, delayMs: 0, failTimes: 0 };

// failTimes を消費するたびに減らす実カウンタ。setMockConfig で failTimes が
// （再）指定されたときだけ、その値で作り直す（会話の途中でリセットしないため）。
let remainingFailures = 0;

export function setMockConfig(patch) {
  Object.assign(mockConfig, patch);
  if ("failTimes" in patch) remainingFailures = patch.failTimes;
}

function resp(status, headers, body) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => body
  };
}

const OPENINGS = [
  "この論点は前提の置き方で結論が変わります。",
  "結論から言えば、条件付きで賛成できます。",
  "その主張には見落としがあると考えます。",
  "まず用語の定義を揃えたいところです。",
  "実務の観点から見ると話が変わります。"
];

function bodyText(req, seedish) {
  const role = /提案側/.test(req) ? "提案" : /批判側/.test(req) ? "批判" : /総括/.test(req) ? "総括" : "自由";
  const open = OPENINGS[seedish % OPENINGS.length];
  return `${open}【${role}】として述べます。` +
    "根拠は3点あります。第一に、判断の基準が明示されていないため比較ができません。" +
    "第二に、示された事例は範囲が限定的で一般化できません。" +
    "第三に、費用と効果の見積りが同じ土俵で行われていません。" +
    "したがって、まず評価軸を決めるべきだと考えます。";
}

// 擬似 fetch。実プロバイダと同じ経路（fetchCombined）を通る。
export async function mockFetch(url, init) {
  const signal = init?.signal;
  if (mockConfig.delayMs > 0) {
    await new Promise((res, rej) => {
      const id = setTimeout(res, mockConfig.delayMs);
      signal?.addEventListener("abort", () => { clearTimeout(id); rej(abortError()); }, { once: true });
    });
  }

  // failTimes===0 は「常に失敗し続ける」（従来どおり）。1以上なら、その回数だけ
  // 失敗してから下の正常応答に抜ける。remainingFailures はここでだけ消費する。
  const shouldFail = mockConfig.failMode &&
    (mockConfig.failTimes === 0 || remainingFailures > 0);
  if (shouldFail) {
    if (mockConfig.failTimes > 0) remainingFailures--;
    switch (mockConfig.failMode) {
      case "429":
        return resp(429, { "retry-after": "3" },
          JSON.stringify({ error: { message: "Rate limit reached. Please try again in 3s." } }));
      case "500":
        return resp(500, {}, JSON.stringify({ error: { message: "internal server error" } }));
      case "timeout":
        // 応答しない。fetchCombined 側のタイムアウトに拾わせる。
        return new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => rej(abortError()), { once: true });
        });
      case "empty":
        return resp(200, {}, JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }));
      case "truncated":   // D-020: 出力上限で切れた応答
        return resp(200, {}, JSON.stringify({
          choices: [{ message: { content: "この論点は前提の置き方で結論が変わります。第一に、判断の基" },
                      finish_reason: "length" }],
          usage: { prompt_tokens: 100, completion_tokens: 32 }
        }));
      case "budget":    // D-024: 思考で枠を使い切り本文が空
        return resp(200, {}, JSON.stringify({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 100, completion_tokens: 500 }
        }));
      case "413":       // D-022: コンテキストの送りすぎ
        return resp(413, {}, "Request Entity Too Large");
      case "badjson":
        return resp(200, {}, JSON.stringify({ choices: [{ message: { content: "はい。```json\n{壊れ" } }] }));
      case "xss":   // AC-A17 の検証用
        return resp(200, {}, JSON.stringify({ choices: [{ message: { content:
          "<script>alert(1)</script> と <img src=x onerror=alert(1)> を含む発言です。" } }] }));
      case "leak":  // AC-A16 の検証用
        return resp(401, {}, JSON.stringify({ error: { message: "Invalid API key: gsk_testkey1234567890abcdefGHIJ" } }));
      default:
        break;
    }
  }

  let req = "";
  try {
    const b = JSON.parse(init.body);
    req = (b.messages ?? []).map((m) => m.content).join("\n");
  } catch { /* 解析できなくても既定文を返す */ }

  // 審判プロンプトには構造化JSONで応える。キー無しでも判定表・論点表を確認できる。
  if (req.includes("あなたは討論の審判です")) {
    const uniq = [...new Set([...req.matchAll(/参加者[A-Z]/g)].map((m) => m[0]))];
    // FR-08-04/05: 観点別に採点し、観点ごとの理由も返す（実プロバイダと同じ形）
    const KEYS = ["logic", "evidence", "rebuttal", "originality"];
    const scores = uniq.map((pt, i) => {
      const criteria = {};
      const reasons = {};
      KEYS.forEach((k, j) => {
        criteria[k] = (i + j * 2 + 1) % 6;          // 0〜5 に散らす
        reasons[k] = "モック審判の採点理由です（" + k + "・" + pt + "）。";
      });
      return { participant: pt, criteria, reasons };
    });
    const total = (s) => KEYS.reduce((a, k) => a + s.criteria[k], 0);
    const winner = scores.reduce((a, b) => (total(b) > total(a) ? b : a), scores[0]);
    return resp(200, {}, JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        scores, winner: winner.participant,
        summary: "モック審判の講評です。評価軸の明確さと反論の的確さに差が出ました。"
      }) }, finish_reason: "stop" }]
    }));
  }
  // FR-08-09（D-070）: 議長の統合にも構造化JSONで応える。結論タブをキー無しで確認できる。
  if (req.includes("あなたは議論の議長です")) {
    const parts = [...new Set([...req.matchAll(/参加者[A-Z]/g)].map((m) => m[0]))];
    return resp(200, {}, JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer: "モック議長の結論です。評価軸を先に定義し、そのうえで段階的に導入するのが最も筋が通ります。" +
                (parts[0] ? parts[0] + "の枠組みを土台に、" : "") + (parts[1] ? parts[1] + "の指摘した環境差への配慮を条件として加えます。" : ""),
        consensus: ["評価軸を先に決める必要がある", "運用コストは無視できない"],
        disagreements: [{ point: "一律に実施すべきか", positions: parts.map((pt, i) => pt + "は" + (i % 2 ? "反対" : "賛成")).join("、") }],
        unique: parts.slice(0, 2).map((pt, i) => ({ participant: pt, point: i ? "環境差の補正が要る" : "評価軸の明確さ" })),
        openQuestions: ["費用を誰が負担するか"]
      }) }, finish_reason: "stop" }]
    }));
  }
  if (req.includes("あなたは議論の分析者です")) {
    const parts = [...new Set([...req.matchAll(/参加者[A-Z]/g)].map((m) => m[0]))];
    // FR-09-03: 1つ目は立場が割れ、2つ目は全員一致という形にして合意度を 1/2 にする
    const issues = [
      { title: "評価軸の定義", agreement: false, positions: parts.map((pt, i) => ({
          participant: pt, stance: i % 2 ? "実質的な公平を重視" : "形式的な一律を重視" })) },
      { title: "運用コスト", agreement: true, positions: parts.map((pt) => ({
          participant: pt, stance: "無視できない負担と見る" })) }
    ];
    // FR-09-04: 追従の指標
    const mindChanges = parts.map((pt, i) => ({ participant: pt, count: i % 2 }));
    return resp(200, {}, JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issues, mindChanges }) },
                  finish_reason: "stop" }]
    }));
  }

  const seedish = req.length;
  return resp(200, {}, JSON.stringify({
    choices: [{ message: { content: bodyText(req, seedish) }, finish_reason: "stop" }],
    usage: { prompt_tokens: Math.ceil(req.length / 3), completion_tokens: 120 }
  }));
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export const mockAdapter = {
  buildRequest({ def, agent, ctx, maxTokens }) {
    return {
      url: "mock://" + agent.provider + "/" + agent.model,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agent.model,
          messages: [
            { role: "system", content: ctx.system },
            { role: "user", content: ctx.user }
          ],
          max_tokens: maxTokens
        })
      }
    };
  },
  extractText: (j) => j?.choices?.[0]?.message?.content ?? "",
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
  capabilities: { json: true, stream: false }
};
