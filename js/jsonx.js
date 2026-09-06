// jsonx.js — 寛容JSONパース（BD §10 / Phase 2）。
// LLM の応答は「はい、以下がJSONです」やコードフェンスで汚れて返る前提で読む。

// テキストから最初の { と最後の } の間を取り出してパースする。
// コードフェンス・前置き・後置きを無視できる。壊れていれば null。
export function extractJson(text) {
  const s0 = String(text ?? "");
  const s = s0.indexOf("{");
  const e = s0.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  const body = s0.slice(s, e + 1);
  try { return JSON.parse(body); } catch { /* そのままでは読めない。下で軽く直す */ }

  // D-063: 末尾カンマ（`{"a":1,}` `[1,2,]`）は LLM の出力で頻出する崩れ方。
  //   これを救えないと、そのたびに再要求で2リクエストを無駄に使い、
  //   最悪は生テキスト送りになる（AC-A15 の経路）。
  //   **直接パースに失敗したときだけ**試すので、元から妥当な JSON の
  //   文字列値に `, }` が含まれていても影響しない。
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
}

// 最小限のスキーマ検証。ajv は入れない（N1: ライブラリ禁止）。
//   schema: { key: "string" | "number" | "array" | "object" | validatorFn }
export function conforms(json, schema) {
  if (!json || typeof json !== "object") return false;
  for (const [key, kind] of Object.entries(schema)) {
    const v = json[key];
    if (typeof kind === "function") { if (!kind(v)) return false; continue; }
    if (kind === "array") { if (!Array.isArray(v)) return false; continue; }
    if (kind === "string" || kind === "number" || kind === "object") {
      if (typeof v !== kind || v === null) return false;
      continue;
    }
  }
  return true;
}

// 構造化出力の再要求ループ（FR-15）。
//   callFn(prompt) はテキスト応答を返す。パースに失敗したら指示を強めて再要求し、
//   maxRetry 回まで試す。それでも駄目なら生テキストを返す（AC-A15）。
export async function requestJson(callFn, prompt, schema, { maxRetry = 2, onLog = () => {} } = {}) {
  let lastText = "";
  for (let i = 0; i <= maxRetry; i++) {
    const extra = i === 0 ? "" :
      "\n\n重要: JSONオブジェクトのみを出力してください。説明文やコードフェンスは不要です。";
    const res = await callFn(prompt + extra);      // 内部で budget.consume される（FR-15-05）
    lastText = res.text ?? "";
    const json = extractJson(lastText);
    if (json && conforms(json, schema)) return { ok: true, json };
    onLog("構造化出力のパースに失敗（" + (i + 1) + "/" + (maxRetry + 1) + "回目）");
  }
  return { ok: false, raw: lastText };
}
