// tests/errors.test.js — エラー正規化とキーのマスク。

import { group, test, eq, ok } from "./runner.js";
import { normalizeError, maskKey, backoffSec, resolveRetrySec, registerSecret } from "../js/errors.js";

const H = { get: () => null };

export function run() {
  group("errors.js エラー正規化");

  test("X-1 ステータスから kind を決める", () => {
    eq(normalizeError(401, H, "{}", "groq").kind, "auth");
    eq(normalizeError(403, H, "{}", "groq").kind, "auth");
    eq(normalizeError(429, H, "{}", "groq").kind, "rate");
    eq(normalizeError(503, H, "{}", "groq").kind, "rate");
    eq(normalizeError(500, H, "{}", "groq").kind, "server");
    eq(normalizeError(418, H, "{}", "groq").kind, "unknown");
    // D-013: 400 / 404 は再試行しても直らないので config として区別する
    eq(normalizeError(404, H, "{}", "groq").kind, "config");
    eq(normalizeError(400, H, "{}", "groq").kind, "config");
    // D-022: 413 はコンテキストの送りすぎ
    eq(normalizeError(413, H, "Request Entity Too Large", "groq").kind, "toolarge");
  });

  test("X-2 エラーメッセージを本文から取り出す", () => {
    const e = normalizeError(429, H, JSON.stringify({ error: { message: "Rate limit reached" } }), "groq");
    eq(e.message, "Rate limit reached");
    eq(e.provider, "groq");
  });

  test("X-3 APIキーをマスクする（AC-A16）", () => {
    ok(!maskKey("Invalid API key: sk-testkey12345678").includes("sk-testkey"), "sk- キーが残った");
    ok(!maskKey("key AIzaSyABCDEFGH12345").includes("AIzaSy"), "AIza キーが残った");
    ok(!maskKey("csk-abcdefgh12345678 は無効").includes("csk-abcdefgh"), "csk- キーが残った");
    eq(maskKey("Authorization: Bearer abcdefgh12345"), "Authorization: Bearer ***");
  });

  test("X-3b 全プロバイダのキー形式をマスクする（D-011）", () => {
    const cases = [
      ["Groq",       "gsk_AbCdEfGh12345678901234567890"],
      ["OpenAI",     "sk-proj-AbCdEfGh12345678901234"],
      ["Anthropic",  "sk-ant-api03-AbCdEfGh1234567890"],
      ["OpenRouter", "sk-or-v1-AbCdEfGh1234567890"],
      ["Cerebras",   "csk-AbCdEfGh1234567890"],
      ["Gemini",     "AIzaSyAbCdEfGh1234567890"]
    ];
    for (const [name, key] of cases) {
      const out = maskKey("Invalid API key: " + key);
      ok(!out.includes(key), name + " のキーが素通りした: " + out);
      ok(out.includes("***"), name + " がマスク記号になっていない");
    }
  });

  test("X-3c 通常の日本語や短い語をむやみに伏せない", () => {
    eq(maskKey("レート制限に達しました"), "レート制限に達しました");
    eq(maskKey("model not found: llama-3.3-70b"), "model not found: llama-3.3-70b");
  });

  test("X-4 正規化を通したメッセージもマスク済み", () => {
    const e = normalizeError(401, H, JSON.stringify({ error: { message: "Invalid API key: sk-testkey12345678" } }), "groq");
    ok(!e.message.includes("sk-testkey"), "正規化後にキーが残った");
    ok(e.message.includes("***"), "マスク記号がない");
  });

  test("X-5 Phase 1a の resolveRetrySec は null（T-09 で実装）", () => {
    eq(resolveRetrySec(429, H, "{}"), null);
  });

  test("X-7 時間単位を含む待機指示を読める（レビュー #4）", () => {
    eq(resolveRetrySec(429, H, "Please try again in 7h37m11.483s. Upgrade..."), 27431.483);
    eq(resolveRetrySec(429, H, "try again in 2h"), 7200);
    eq(resolveRetrySec(429, H, "try again in 1m30s"), 90);
  });

  test("X-9 Gemini の「Please retry in Ns」も待機秒数として読む（D-082）", () => {
    // 実際に踏んだ: Groq は "try again in"、Gemini は "retry in" と書く。
    // 後者を読めず指数バックオフ（2/4/8秒）で3回叩いて諦めていた。
    // 本文には「58秒待て」と書いてあったので、素直に待てば通っていた。
    const body = "You exceeded your current quota... Please retry in 58.011638719s.";
    eq(resolveRetrySec(429, H, body), 58.011638719);
    eq(resolveRetrySec(429, H, "Please retry in 2m"), 120);
    // Groq の言い回しも従来どおり読める
    eq(resolveRetrySec(429, H, "Please try again in 23.389999999s"), 23.389999999);
    // 429/503 以外では読まない
    eq(resolveRetrySec(400, H, "Please retry in 58s"), null);
  });

  test("X-8 接頭辞の無いキーもマスクされる（レビュー #7）", () => {
    // 32文字の英数字をそのまま書くと GitHub の Push Protection が Mistral のキーと誤検知して
    // 配信用リポジトリへの push を止める（D-073）。実行時に連結して、ファイル上には現れないようにする。
    const mistral = ["aBcDeFgH", "iJkLmNoP", "qRsTuVwX", "yZ012345"].join("");
    ok(!maskKey("Unauthorized: " + mistral).includes(mistral), "長い英数字トークンが素通り");
    registerSecret("my-odd.key/withSep123");
    ok(!maskKey("bad key my-odd.key/withSep123 given").includes("withSep123"), "登録済みの実値が素通り");
    eq(maskKey("model not found: llama-3.3-70b"), "model not found: llama-3.3-70b");
  });

  test("X-6 指数バックオフは 2,4,8,16 で頭打ち", () => {
    eq([1, 2, 3, 4, 5].map(backoffSec), [2, 4, 8, 16, 16]);
  });
}
