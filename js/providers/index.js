// providers/index.js — プロバイダ呼び出しの共通経路。
// 状態層は参照しない。予算は budget として注入される（BD §5.1）。

import { PROVIDERS } from "../config.js";
import { normalizeError } from "../errors.js";
import { mockAdapter } from "./mock.js";
import { openaiCompatAdapter } from "./openai-compat.js";
import { geminiAdapter } from "./gemini.js";
import { anthropicAdapter } from "./anthropic.js";

export const ADAPTERS = {
  mock: mockAdapter,
  "openai-compat": openaiCompatAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter
};

// AbortSignal.any は使わない。中断理由を stop / timeout で区別する（BD §5.2）。
// レビュー #5: タイムアウトと中断は「本文の読み終わり」まで効かせる。ヘッダ到着で
//   タイマーを解除すると、本文送出が止まったサーバでターンが永久にハングする。
//   そのため本文の読み取りもこの関数の中で行い、{ ok, status, headers, body } を返す。
export async function fetchCombined(url, init, { signal, timeoutMs }, fetchImpl = fetch) {
  const ac = new AbortController();
  let reason = null;
  const onAbort = () => { reason = "stop"; ac.abort(); };
  const timer = setTimeout(() => { reason = "timeout"; ac.abort(); }, timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    const body = await res.text();   // 本文読み取り中もタイマーと中断が生きている
    return { ok: res.ok, status: res.status, headers: res.headers, body };
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw {
        kind: reason === "timeout" ? "timeout" : "aborted",
        status: 0, retryAfterSec: null,
        message: reason === "timeout" ? "応答がタイムアウトしました" : "中断されました"
      };
    }
    throw { kind: "network", status: 0, retryAfterSec: null, message: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// D-014: 利用できるモデルはプロバイダ側で入れ替わる。設定画面から取得して選ばせる。
//   ハードコードした一覧は必ず古くなり、「モデルが存在しない」で全員離脱する。
// レビュー #6: 一覧はページ分割されて返る（Gemini 既定50件・Anthropic 既定20件）。
//   先頭ページだけ見ると使えるモデルが欠けるので、続きを辿って集める。
export async function listModels(provider, apiKey, { timeoutMs = 20000, fetchImpl = null } = {}) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error("未知のプロバイダです");
  if (!def.modelsPath) throw new Error(def.label + " はモデル一覧の取得に対応していません");

  const headers = { ...(def.extraHeaders ?? {}) };
  if (def.auth === "bearer") headers["Authorization"] = "Bearer " + (apiKey ?? "");
  else if (def.auth === "x-goog-api-key") headers["x-goog-api-key"] = apiKey ?? "";
  else if (def.auth === "x-api-key") headers["x-api-key"] = apiKey ?? "";

  const base = def.origin + def.modelsPath;
  const sep = base.includes("?") ? "&" : "?";
  // 大きめのページを頼む。対応しないAPIはクエリを無視するだけなので無害。
  let url = base + sep + (def.auth === "x-goog-api-key" ? "pageSize=1000" : "limit=1000");

  const items = [];
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetchCombined(url, { method: "GET", headers }, { timeoutMs },
                                    fetchImpl ?? def.fetchImpl ?? fetch);
    if (!res.ok) throw new Error(normalizeError(res.status, res.headers, res.body, provider).message);

    const j = JSON.parse(res.body);
    items.push(...(j.data ?? j.models ?? []));

    if (j.nextPageToken) {                       // Gemini 形式
      url = base + sep + "pageSize=1000&pageToken=" + encodeURIComponent(j.nextPageToken);
    } else if (j.has_more && j.last_id) {        // Anthropic 形式
      url = base + sep + "limit=1000&after_id=" + encodeURIComponent(j.last_id);
    } else {
      url = null;
    }
  }

  const seen = new Set();
  return items
    .map((m) => {
      const id = String(m.id ?? m.name ?? "").replace(/^models\//, "");
      // Gemini は supportedGenerationMethods で generateContent 可否が分かる
      const methods = m.supportedGenerationMethods;
      const chat = Array.isArray(methods)
        ? methods.includes("generateContent") && isChatModel(id)
        : isChatModel(id);
      return {
        id,
        contextWindow: m.context_window ?? m.context_length ?? m.inputTokenLimit ?? null,
        ownedBy: m.owned_by ?? null,
        chat
      };
    })
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
    // D-019: アルファベット順だと allam-2-7b のような小さいモデルが先頭に来る。
    //   コンテキスト長の大きい順にすると、実用的なモデルが自然に上へ来る。
    .sort((a, b) => {
      if (a.chat !== b.chat) return a.chat ? -1 : 1;
      const ca = a.contextWindow ?? 0;
      const cb = b.contextWindow ?? 0;
      if (ca !== cb) return cb - ca;
      return a.id.localeCompare(b.id);
    });
}

// D-016: /models は議論に使えないモデルも返す。音声認識・音声合成・ガードレール・
//   埋め込みは chat/completions では動かないので、既定では選択肢から外す。
const NON_CHAT = /whisper|tts|orpheus|speech|guard|embed|rerank|moderation|image|imagen|veo|live|audio|aqa|learnlm|computer-use|robotics/i;

export function isChatModel(id) {
  return !NON_CHAT.test(id);
}

export async function callProvider(agent, ctx, opts = {}) {
  const {
    signal, timeoutMs = 60000, budget, maxTokens = 800, json = false,
    getKey = () => "", reasoningEffort
  } = opts;
  const def = PROVIDERS[agent.provider];
  if (!def) throw { kind: "unknown", status: 0, retryAfterSec: null, message: `未知のプロバイダ: ${agent.provider}` };
  const ad = ADAPTERS[def.adapter];
  if (!ad) throw { kind: "unknown", status: 0, retryAfterSec: null, message: `未実装のアダプタ: ${def.adapter}` };

  budget?.check();   // 上限チェックは fetch 発行前

  const { url, init } = ad.buildRequest({
    def, agent, ctx, apiKey: getKey(agent.provider), maxTokens, json, reasoningEffort
  });

  budget?.consume(agent.provider);   // 成功・失敗を問わず加算（BD §5.1）

  const started = Date.now();
  const res = await fetchCombined(url, init, { signal, timeoutMs }, def.fetchImpl ?? fetch);
  const body = res.body;
  if (!res.ok) throw ad.parseError(res.status, res.headers, body, agent.provider);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw { kind: "parse", status: res.status, retryAfterSec: null,
            provider: agent.provider, message: "応答が JSON として読めません" };
  }

  const finishReason = ad.extractFinishReason?.(parsed) ?? null;
  // アダプタが文字列以外を返しても以降が落ちないようにする（D-061）。
  // ここで String() に潰すと "[object Object]" が発言として混入してしまうため、
  // **空扱いにして既存の empty 経路（再試行→失敗計上）に乗せる**。
  // 応答の形を正しく解くのはアダプタの責務で、ここは最後の防波堤に徹する。
  const rawText = ad.extractText(parsed);
  const text = typeof rawText === "string" ? rawText : "";
  if (!text || !text.trim()) {
    // D-024: 本文が空でしかも "length" は、出力枠を思考トークンで使い切った状態。
    //   再試行しても同じ結果になるので、空応答とは別の種類として返す。
    if (finishReason === "length") {
      throw { kind: "budget", status: res.status, retryAfterSec: null, provider: agent.provider,
              message: "出力枠を思考トークンで使い切り、本文が空のまま返ってきました" };
    }
    throw { kind: "empty", status: res.status, retryAfterSec: null,
            provider: agent.provider, message: ad.describeEmpty(parsed) };
  }

  return {
    text: text.trim(),
    usage: ad.extractUsage(parsed),
    finishReason,
    elapsedMs: Date.now() - started
  };
}
