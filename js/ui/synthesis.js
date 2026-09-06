// ui/synthesis.js — 議長による統合（結論タブ・FR-08-09・D-070）。

import { on, state } from "../state.js";
import { el, clear } from "./dom.js";
import { AGENT_SHAPES } from "../config.js";

function nameOf(id, fallback) {
  const a = state.session?.config.agents.find((x) => x.id === id);
  return a ? AGENT_SHAPES[a.shapeIndex] + " " + a.name : (fallback ?? id ?? "");
}

export function mountSynthesis(root) {
  function section(title, items, render) {
    if (!Array.isArray(items) || !items.length) return;
    root.appendChild(el("h3", { class: "verdict-subhead", text: title }));
    const ul = el("ul", { class: "synth-list" });
    for (const x of items) ul.appendChild(el("li", {}, render(x)));
    root.appendChild(ul);
  }

  function render(syn) {
    clear(root);
    if (!syn) {
      root.appendChild(el("p", { class: "placeholder",
        text: "まだ結論がありません。設定の審判で「結論を統合する」を有効にして議論を完走させてください。" }));
      return;
    }
    // verdict.js / issues.js と同じく、壊れた形（インポート経路）も原文表示へ落とす（AC-A15）
    const raw = syn.raw ?? (typeof syn.answer === "string" ? null : JSON.stringify(syn).slice(0, 4000));
    if (raw) {
      root.appendChild(el("p", { class: "placeholder",
        text: "議長の応答を構造化できなかったため、原文のまま表示します。" }));
      root.appendChild(el("pre", { class: "verdict-raw", text: raw }));
      return;
    }

    root.appendChild(el("div", { class: "synth-answer" }, [
      el("div", { class: "topic-label", text: "議長による結論" }),
      el("div", { class: "synth-answer-text", text: syn.answer })
    ]));

    section("一致した点", syn.consensus, (x) => [String(x)]);
    section("割れた点", syn.disagreements, (d) => [
      el("div", { text: String(d?.point ?? "") }),
      d?.positions ? el("div", { class: "synth-pos", text: String(d.positions) }) : null
    ]);
    section("1体だけが指摘した点", syn.unique, (u) => [
      el("span", { class: "synth-who", text: nameOf(u?.agentId, u?.participant) + ": " }),
      String(u?.point ?? "")
    ]);
    section("残った問い", syn.openQuestions, (x) => [String(x)]);

    root.appendChild(el("p", { class: "field-hint",
      text: "議長は匿名化した議論（参加者A/B/…）を読んで統合しています。参加者名は表示のときに戻しています" }));
  }

  on("evaluation:done", ({ synthesis }) => render(synthesis ?? null));
  on("session:restored", (s) => render(s.synthesis ?? null));
  on("session:started", (s) => render(s.synthesis ?? null));
  render(null);
}
