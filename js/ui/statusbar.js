// ui/statusbar.js — 画面下部の使用量表示。textContent の更新のみ。

import { on, state } from "../state.js";
import { el, clear } from "./dom.js";
import { PROVIDERS } from "../config.js";

function label(p) { return PROVIDERS[p]?.label ?? p; }

// 発言分のトークン合計。1件も記録が無ければ null（表示しない）。
export function sumTokens(s) {
  let tokensIn = 0, tokensOut = 0, any = false;
  for (const t of s.turns ?? []) {
    if (Number.isFinite(t.tokensIn)) { tokensIn += t.tokensIn; any = true; }
    if (Number.isFinite(t.tokensOut)) { tokensOut += t.tokensOut; any = true; }
  }
  return any ? { tokensIn, tokensOut } : null;
}

export function mountStatusbar(root, usage) {
  const daily = el("span", { class: "sb-daily" });
  const session = el("span", { class: "sb-session" });
  const note = el("span", { class: "sb-note", text: "日次は UTC 基準の目安（正確な残枠ではありません）" });
  clear(root);
  root.appendChild(daily);
  root.appendChild(session);
  root.appendChild(note);

  function renderDaily(snap) {
    const parts = Object.entries(snap.counts)
      .filter(([p]) => p !== "mock")
      .map(([p, n]) => label(p) + " " + n);
    daily.textContent = parts.length
      ? "今日のリクエスト: " + parts.join(" / ")
      : "今日のリクエスト: まだありません";
  }

  // D-070: 発言ごとの tokensIn/tokensOut は Phase 1b から記録していたが、合計はどこにも
  //   出ていなかった。従量課金のプロバイダ（OpenAI / Anthropic）ではここが費用の実態になる。
  //   審判の呼び出しは turns に載らないため含まない（表示にもそう書く）。
  function renderSession() {
    const s = state.session;
    if (!s) { session.textContent = ""; return; }
    let text = "このセッション: " + s.requestCount + " / " + s.config.requestLimit;
    const t = sumTokens(s);
    if (t) text += "・トークン 入 " + t.tokensIn.toLocaleString() + " / 出 " + t.tokensOut.toLocaleString() + "（発言分）";
    session.textContent = text;
  }

  renderDaily(usage.snapshot());
  on("usage:daily", renderDaily);
  on("usage:changed", renderSession);
  on("turn:committed", renderSession);
  on("session:started", renderSession);
  on("session:restored", renderSession);
}
