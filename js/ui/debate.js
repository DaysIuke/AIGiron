// ui/debate.js — 発言カード。append のみ。AI応答は必ず textContent 経由で入れる。

import { on } from "../state.js";
import { el } from "./dom.js";
import { ROLE_LABELS, AGENT_SHAPES, HUMAN_ID } from "../config.js";
import { state } from "../state.js";
import { renderMarkdownLite } from "../mdlite.js";

function agentOf(agentId) {
  return state.session?.config.agents.find((a) => a.id === agentId);
}

export function mountDebate(root) {
  on("session:started", (s) => {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(el("div", { class: "topic-card" }, [
      el("div", { class: "topic-label", text: "議題" }),
      el("div", { class: "topic-text", text: s.topic })
    ]));
  });

  on("turn:committed", (t) => {
    const a = agentOf(t.agentId);
    const human = t.agentId === HUMAN_ID;   // FR-05-07: 司会（人間）の差し込み
    const cls = human ? "turn-human" : "agent-" + (a?.colorIndex ?? 0);
    const card = el("article", { class: "turn-card " + cls, dataset: { round: String(t.round) } }, [
      el("header", { class: "turn-head" }, [
        human ? null : el("span", { class: "turn-shape " + cls, text: AGENT_SHAPES[a?.shapeIndex ?? 0] }),
        el("span", { class: "turn-name " + cls, text: human ? "司会（あなた）" : (a?.name ?? t.agentId) }),
        el("span", { class: "turn-role", text: ROLE_LABELS[t.role] ?? t.role }),
        el("span", { class: "turn-meta", text: "R" + t.round + " / " + t.chars + "字" }),
        t.truncated ? el("span", { class: "turn-warn", text: "途中で切れています" }) : null
      ]),
      // AI応答は mdlite.js の安全なサブセットで整形する。HTML文字列の流し込みは使わず、
      // 常に el()（textContent 経由）でDOMへ入れるので AC-A17 は変わらず保たれる（NFR-03-02）。
      el("div", { class: "turn-body" }, renderMarkdownLite(t.text)),
      t.truncated ? el("div", { class: "turn-warn-note",
        text: "出力上限に達したため、この発言は文の途中で終わっています。" }) : null
    ]);
    // #panel-debate 自体はスクロールしないのでページ側を見る。末尾付近を見ているときだけ
    // 追従し、過去の発言を読み返している最中に新しい発言で引き戻さない（log.js と同じ方針）。
    const se = document.scrollingElement ?? document.documentElement;
    const follow = se.scrollHeight - se.scrollTop - se.clientHeight < 120;

    root.appendChild(card);
    if (follow) card.scrollIntoView({ block: "nearest" });
  });
}
