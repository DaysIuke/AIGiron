// errors.js — エラーの正規化・キーのマスク・待機秒数の決定。

// APIキーらしき文字列を落とす。ログ・エラー表示は必ずここを通す。
// 接頭辞はプロバイダごとに違い、区切りもハイフンとアンダースコアの両方がある。
//   OpenAI sk-… / Anthropic sk-ant-… / OpenRouter sk-or-v1-… / Cerebras csk-… / Groq gsk_…
// 取りこぼすくらいなら余分に伏せる方に倒す（D-011）。
// 設定済みキーの実値。接頭辞パターンに頼らず完全一致で伏せる（レビュー #7）。
//   Mistral のキーは接頭辞なしの英数字で、パターンでは判別できない。
const KNOWN_SECRETS = new Set();

export function registerSecret(value) {
  const v = String(value ?? "");
  if (v.length >= 8) KNOWN_SECRETS.add(v);
}

export function maskKey(text) {
  let s = String(text ?? "");
  for (const k of KNOWN_SECRETS) s = s.split(k).join("***");
  return s
    .replace(/\b[A-Za-z]{0,4}sk[-_][A-Za-z0-9_-]{8,}/g, "***")
    .replace(/\bAIza[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    // 区切りのない長い英数字はキーの可能性が高い。余分に伏せる方に倒す（D-011）
    .replace(/\b[A-Za-z0-9]{28,}\b/g, "***");
}

// 共通の既定実装。各アダプタの parseError() はこれを呼んだ上で固有情報を足す。
export function normalizeError(status, headers, bodyText, provider) {
  let kind = "unknown";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429 || status === 503) kind = "rate";
  else if (status >= 500) kind = "server";
  // 400 / 404 はリクエストの中身が悪い。再試行しても永久に直らないので config として区別する（D-013）。
  // 典型は「モデルが存在しない」。廃止されたモデルIDを設定に持ち続けると必ずここに来る。
  else if (status === 400 || status === 404) kind = "config";
  // 413 はコンテキストを送りすぎている。設定を変えないと直らない（D-022）。
  else if (status === 413) kind = "toolarge";

  let message = "";
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message ?? j?.message ?? j?.error?.status ?? "";
  } catch { /* JSON でなければ本文をそのまま使う */ }
  if (!message) message = String(bodyText ?? "").slice(0, 300);

  // D-026: Gemini はキー不正を 400 INVALID_ARGUMENT で返す。ステータスだけ見ると
  //   config（設定の誤り）に落ちて「モデル名が違う」と案内してしまう。本文で拾う。
  if ((status === 400 || status === 403) && /api key not valid|invalid api key|api_key_invalid/i.test(message)) {
    kind = "auth";
  }

  if (kind === "toolarge") {
    message = "送信したコンテキストが大きすぎます（" + message + "）";
  }

  // D-028: 「提供終了。models/X を使え」と案内してくる場合、後継モデル名を取り出しておく。
  //   engine がこれを見てモデルを差し替え、同じターンを1度だけ張り直す。
  let replacementModel = null;
  if (kind === "config") {
    // モデル名はドットを含む（gemini-3.6-flash）ので、非貪欲にすると "gemini-3" で止まる。
    // 貪欲に取り、末尾が英数字で終わるよう縛って句読点を落とす。
    // 一般英単語（"use another model" の another 等）を拾わないよう、
    // 数字か区切り（. / -）を含むトークンだけをモデル名とみなす（レビュー minor）。
    const m = /use\s+`?(?:models\/)?((?=[a-z0-9._/-]*[\d./-])[a-z0-9][a-z0-9._/-]*[a-z0-9])`?/i.exec(message);
    if (m && /no longer|deprecated|retired|not available|migrate|update your code/i.test(message)) {
      replacementModel = m[1];
    }
  }

  return { kind, status, retryAfterSec: null, message: maskKey(message), provider, replacementModel };
}

// "23.39s" / "1m30s" / "500ms" / "2m59.56s" を秒に直す。
function parseDuration(text) {
  if (!text) return null;
  const s = String(text);

  const ms = /^\s*([\d.]+)\s*ms\s*$/i.exec(s);
  if (ms) return Number(ms[1]) / 1000;

  // 時間単位も受ける。Groq の日次上限は "7h37m11.483s" の形で返る（レビュー #4）。
  const composed = /(?:([\d.]+)\s*h)?\s*(?:([\d.]+)\s*m(?!s))?\s*(?:([\d.]+)\s*s)?/i.exec(s);
  if (composed && (composed[1] || composed[2] || composed[3])) {
    const total = Number(composed[1] ?? 0) * 3600 +
                  Number(composed[2] ?? 0) * 60 +
                  Number(composed[3] ?? 0);
    if (Number.isFinite(total) && total > 0) return total;
  }

  const bare = Number(s);
  return Number.isFinite(bare) && bare >= 0 ? bare : null;
}

// 待機秒数の4段フォールバック（BD §5.5 / T-09）。
// ①標準ヘッダ ②Gemini の RetryInfo ③本文のメッセージ ④決定不能（=null → 指数バックオフ）
export function resolveRetrySec(status, headers, bodyText) {
  if (status !== 429 && status !== 503) return null;

  // ① Retry-After ヘッダ。秒数か HTTP-date。
  const h = headers?.get?.("retry-after");
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, (d - Date.now()) / 1000);
  }

  // ② Gemini の RetryInfo（error.details[].retryDelay = "23.4s"）
  try {
    const j = JSON.parse(bodyText);
    for (const d of j?.error?.details ?? []) {
      if (String(d["@type"] ?? "").endsWith("RetryInfo") && d.retryDelay) {
        const sec = parseDuration(d.retryDelay);
        if (sec !== null) return sec;
      }
    }
  } catch { /* JSON でなければ ③ に落ちる */ }

  // ③ 本文のメッセージ。小数を落とすと1秒早く叩いて再び弾かれるので、期間表現ごと拾う。
  //    プロバイダごとに言い回しが違う（D-082）:
  //      Groq   : "Please try again in 23.389999999s"
  //      Gemini : "Please retry in 58.011638719s"  ← "try again in" では一致しない
  //    実際に踏んだ: Gemini の 429 で秒数を読み落とし、指数バックオフ（2/4/8秒）で
  //    3回叩いて諦めていた。本文には「58秒待て」と書いてあったので、素直に待てば通っていた。
  const m = /(?:try again|retry)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:ms|[hms])\s*)+|\d+(?:\.\d+)?)/i
    .exec(String(bodyText ?? ""));
  if (m) {
    const sec = parseDuration(m[1].trim());
    if (sec !== null) return sec;
  }

  // ④ 決定不能。呼び出し側の指数バックオフに委ねる。
  return null;
}

// 指数バックオフ。2, 4, 8, 16 秒で頭打ち。
export function backoffSec(retries) {
  return Math.min(16, 2 ** Math.max(1, retries));
}
