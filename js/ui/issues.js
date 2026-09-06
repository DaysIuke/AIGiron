// ui/issues.js — 論点と各参加者の立場の表（Phase 2）。

import { on, state } from "../state.js";
import { el, clear } from "./dom.js";
import { AGENT_SHAPES } from "../config.js";
import { consensusRate, mindChanges } from "../judge.js";

function agentOf(id) {
  return state.session?.config.agents.find((a) => a.id === id);
}

function nameOf(id, fallback) {
  const a = agentOf(id);
  return a ? AGENT_SHAPES[a.shapeIndex] + " " + a.name : (fallback ?? id);
}

export function mountIssues(root) {
  function render(issues) {
    clear(root);
    if (!issues) {
      root.appendChild(el("p", { class: "placeholder",
        text: "まだ論点がありません。設定で審判を有効にして議論を完走させてください。" }));
      return;
    }
    // verdict.js と同じ理由で、issues が配列でないものも原文表示へ落とす。
    // インポート経路（FR-07-06）は issues の形を検証していない。
    const raw = issues.raw ??
      (Array.isArray(issues.issues) ? null : JSON.stringify(issues).slice(0, 4000));
    if (raw) {
      root.appendChild(el("p", { class: "placeholder",
        text: "論点の応答を構造化できなかったため、原文のまま表示します。" }));
      root.appendChild(el("pre", { class: "verdict-raw", text: raw }));
      return;
    }

    // FR-09-03: 合意度メーター（A037 ReConcile / B050）。
    //   立場は自由記述のため文字列比較では判定できず、分析者が論点ごとに返した
    //   agreement を集計する。返ってこなかった論点は母数から外す。
    const cons = state.session ? consensusRate(state.session) : null;
    if (cons) {
      const pct = Math.round(cons.rate * 100);
      root.appendChild(el("div", { class: "consensus" }, [
        el("div", { class: "consensus-head" }, [
          el("span", { class: "consensus-label", text: "合意度" }),
          el("span", { class: "consensus-value", text:
            pct + "%（" + cons.agreed + " / " + cons.total + " 論点で立場が一致）" })
        ]),
        el("div", { class: "consensus-track" }, [
          // 幅は data 属性 + CSS で当てる（style 属性・CSSOM は禁止・VF-02）
          el("div", { class: "consensus-fill", dataset: { pct: String(Math.round(cons.rate * 10)) } })
        ])
      ]));
    }

    for (const issue of issues.issues) {
      const card = el("div", { class: "issue-card" }, [
        el("div", { class: "issue-head" }, [
          el("span", { class: "issue-title", text: String(issue.title ?? "") }),
          issue.agreement === true
            ? el("span", { class: "issue-badge is-agree", text: "全員一致" })
            : issue.agreement === false
              ? el("span", { class: "issue-badge is-split", text: "立場が割れた" })
              : null
        ])
      ]);
      for (const p of (Array.isArray(issue.positions) ? issue.positions : [])) {
        const a = agentOf(p.agentId);
        const cls = a ? "agent-" + a.colorIndex : "";
        card.appendChild(el("div", { class: "issue-pos" }, [
          el("span", { class: "issue-name " + cls, text:
            a ? AGENT_SHAPES[a.shapeIndex] + " " + a.name : p.participant }),
          el("span", { class: "issue-stance", text: p.stance })
        ]));
      }
      root.appendChild(card);
    }

    // FR-09-04: 押されて意見を変えた回数（B012/B021 の追従指標）
    const mc = state.session ? mindChanges(state.session) : null;
    if (mc) {
      root.appendChild(el("h3", { class: "verdict-subhead", text: "意見を変えた回数（追従の指標）" }));
      const table = el("div", { class: "mind-table" });
      for (const m of mc) {
        table.appendChild(el("div", { class: "mind-row" }, [
          el("span", { class: "mind-name", text: nameOf(m.agentId, m.participant) }),
          el("span", { class: "mind-count", text: m.count + " 回" })
        ]));
      }
      root.appendChild(table);
      root.appendChild(el("p", { class: "field-hint", text:
        "他者に説得されて立場を変えた回数の目安です。多いほど追従的（B012）、" +
        "0 が続く場合は逆に反論を受け止めていない可能性があります" }));
    }
  }

  on("evaluation:done", ({ issues }) => render(issues));
  on("session:restored", (s) => render(s.issues));
  on("session:started", (s) => render(s.issues ?? null));
  render(null);
}
