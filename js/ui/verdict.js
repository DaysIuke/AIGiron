// ui/verdict.js — 審判の採点表示（Phase 2）。

import { on, state, emit } from "../state.js";
import { el, clear } from "./dom.js";
import { AGENT_SHAPES } from "../config.js";
import { lengthScoreCorrelation, CRITERIA, CRITERIA_LABELS, CRITERION_MAX } from "../judge.js";

function agentOf(id) {
  return state.session?.config.agents.find((a) => a.id === id);
}

function nameOf(id) {
  const a = agentOf(id);
  return a ? AGENT_SHAPES[a.shapeIndex] + " " + a.name : id;
}

export function mountVerdict(root) {
  function render(judgement) {
    clear(root);
    // FR-08-06: 審判の判定が無い／壊れている場合でも、人間の投票は独立して行えるようにする
    //   （議論を見たのは人間なので、AIの採点が無いことは投票できない理由にならない）。
    if (!judgement) {
      root.appendChild(el("p", { class: "placeholder",
        text: "まだ判定がありません。設定で審判を有効にして議論を完走させてください。" }));
      renderVote();
      return;
    }
    // AC-A15: 構造化に失敗したら生テキストで見せる（捨てない）。
    // scores が配列でない judgement もここへ落とす。審判が作った判定は必ず配列だが、
    // インポートしたセッション（FR-07-06）は looksLikeSession() が judgement の形まで
    // 見ないため、壊れた形のまま届きうる。素通ししていたときは [...judgement.scores] が
    // 投げ、state.js の購読ガードに握られて判定タブが白紙になり、独立しているはずの
    // 人間の投票（FR-08-06）まで出なくなっていた。
    const raw = judgement.raw ??
      (Array.isArray(judgement.scores) ? null : JSON.stringify(judgement).slice(0, 4000));
    if (raw) {
      root.appendChild(el("p", { class: "placeholder",
        text: "審判の応答を構造化できなかったため、原文のまま表示します。" }));
      root.appendChild(el("pre", { class: "verdict-raw", text: raw }));
      renderVote();
      return;
    }

    const sorted = [...judgement.scores].sort((a, b) => b.score - a.score);
    const table = el("div", { class: "verdict-table" });
    for (const s of sorted) {
      const a = agentOf(s.agentId);
      const cls = a ? "agent-" + a.colorIndex : "";
      const isWinner = judgement.winnerAgentId && s.agentId === judgement.winnerAgentId;
      const max = s.maxScore ?? 10;
      // バーの長さは満点で正規化して 0〜10 段階に落とす（旧形式=10点満点も同じ見た目になる）
      const w = Math.round((s.score / max) * 10);
      table.appendChild(el("div", { class: "verdict-row" + (isWinner ? " verdict-winner" : "") }, [
        el("span", { class: "verdict-name " + cls, text:
          (a ? AGENT_SHAPES[a.shapeIndex] + " " + a.name : s.participant) + (isWinner ? "（勝者）" : "") }),
        el("span", { class: "verdict-score", text: String(s.score) + " / " + max }),
        el("span", { class: "verdict-bar-wrap" }, [
          el("span", { class: "verdict-bar " + cls, dataset: { w: String(w) } })
        ]),
        el("span", { class: "verdict-reason", text: s.reason })
      ]));
      // FR-08-04/05: 観点別の点数と、観点ごとの理由。旧形式（criteria 無し）では出さない。
      if (s.criteria) {
        const grid = el("div", { class: "criteria-grid" });
        for (const k of CRITERIA) {
          grid.appendChild(el("div", { class: "criteria-row" }, [
            el("span", { class: "criteria-name", text: CRITERIA_LABELS[k] }),
            el("span", { class: "criteria-score", text: s.criteria[k] + " / " + CRITERION_MAX }),
            el("span", { class: "criteria-bar-wrap" }, [
              el("span", { class: "criteria-bar " + cls, dataset: { w: String(s.criteria[k]) } })
            ]),
            el("span", { class: "criteria-reason", text: s.reasons?.[k] ?? "" })
          ]));
        }
        table.appendChild(el("div", { class: "criteria-block" }, [grid]));
      }
    }
    root.appendChild(table);
    if (judgement.summary) {
      root.appendChild(el("div", { class: "verdict-summary" }, [
        el("div", { class: "topic-label", text: "講評" }),
        el("div", { text: judgement.summary })
      ]));
    }

    // FR-08-07: 安定性チェックの結果（既定OFFなので stability が無いことも多い）
    if (judgement.stability?.checked) {
      const cls = judgement.stability.unstable ? "verdict-unstable" : "verdict-stable";
      const text = judgement.stability.unstable
        ? "⚠ 参加者のラベル割り当てを反転すると勝者が変わりました（不安定）。この判定は参考程度にしてください"
        : "参加者のラベル割り当てを反転しても勝者は変わりませんでした（安定）";
      root.appendChild(el("p", { class: "field-hint " + cls, text }));
    } else if (judgement.stability && !judgement.stability.checked) {
      root.appendChild(el("p", { class: "field-hint",
        text: "安定性チェックは実行できませんでした（" + judgement.stability.reason + "）" }));
    }

    root.appendChild(el("p", { class: "field-hint",
      text: "採点は匿名化した発言に対して行われます（名前・モデルへの先入観を断つため）" }));

    // FR-08-08: 発言の長さと得点の相関（B010 冗長性バイアスの可視化）
    // D-076: 打ち切って採点した場合、審判が読んだ発言はすべて同じ長さなので、
    //   この相関は「審判が長さに釣られたか」を測っていない（B010 の検出は成立しない）。
    //   元の長さで計算した値をそのまま出すと、0 に近い値を「バイアスなし」と読ませてしまう。
    const truncated = judgement.transcriptTruncated ?? null;
    const corr = state.session ? lengthScoreCorrelation(state.session) : null;
    if (corr) {
      root.appendChild(el("h3", { class: "verdict-subhead", text: "文字数と得点の相関" }));
      const corrTable = el("div", { class: "corr-table" });
      for (const p of corr.points) {
        corrTable.appendChild(el("div", { class: "corr-row" }, [
          el("span", { class: "corr-name", text: nameOf(p.agentId) }),
          el("span", { class: "corr-chars", text: Math.round(p.avgChars) + " 字/発言（平均）" }),
          el("span", { class: "corr-score", text: p.score + " / 10" })
        ]));
      }
      root.appendChild(corrTable);
      const rText = corr.r === null ? "算出できません（値にばらつきがありません）"
        : corr.r.toFixed(2) + (truncated
            ? "（この値は冗長性バイアスの判定に使えません）"
            : Math.abs(corr.r) >= 0.5
              ? "（長さと得点に相関が見られます。冗長性バイアスの疑いがあります・B010）"
              : "（長さと得点に強い相関は見られません）");
      root.appendChild(el("p", { class: "field-hint", text: "相関係数: " + rText }));
      if (truncated) {
        root.appendChild(el("p", { class: "field-hint judge-warn", text:
          "議論が長かったため、審判には各発言を " + truncated.perTurnChars +
          " 字ずつに揃えて渡しています。審判が読んだ発言はすべて同じ長さなので、" +
          "この相関は「審判が長さに釣られたか」を測っていません（B010 の検出は成立しません）。" +
          "上の文字数は打ち切る前の元の長さです" }));
      }
    }

    renderVote();
  }

  // FR-08-06: 人間による投票（勝者選択・各AIへの星）。AIの判定とは別に記録する。
  //   R-04（審判の判定が不安定）への対策として、AIの採点に人間の評価を併設する（C042）。
  function renderVote() {
    const s = state.session;
    if (!s || !s.config?.agents?.length) return;

    root.appendChild(el("h3", { class: "verdict-subhead", text: "あなたの評価（AIの判定とは別に記録します）" }));
    const votes = s.votes ?? { winnerAgentId: null, stars: {}, at: null };

    // FR-08-11（D-078）: B003 の Human-in-the-Loop Calibration。
    //   「難しい例では人間に助けを求める」を、判定が割れているときの促しとして実装する。
    //   常に出すと文字が増えるだけなので、**不安定 or 僅差のときだけ**出す。
    const need = needsHuman(s.judgement);
    if (need && !votes.at) {
      root.appendChild(el("p", { class: "field-hint judge-warn", text:
        "この判定は割れています（" + need + "）。あなたの判断を記録しておくと、" +
        "履歴の集計で「この審判はあなたの基準とどれだけ合うか」が分かるようになります" }));
    }

    const box = el("div", { class: "vote-box" });

    for (const a of s.config.agents) {
      const cls = "agent-" + a.colorIndex;
      const isWinner = votes.winnerAgentId === a.id;
      const stars = el("span", { class: "vote-stars" });
      for (let n = 1; n <= 5; n++) {
        const on5 = (votes.stars?.[a.id] ?? 0) >= n;
        stars.appendChild(el("button", {
          type: "button", class: "vote-star", dataset: { on: String(on5) },
          text: on5 ? "★" : "☆",
          title: a.name + " に " + n + " つ星",
          "aria-label": a.name + " に " + n + " つ星",
          onClick: () => {
            const next = { ...(votes.stars ?? {}) };
            next[a.id] = next[a.id] === n ? 0 : n;   // 同じ星をもう一度押したら取り消す
            saveVote({ ...votes, stars: next });
          }
        }));
      }
      box.appendChild(el("div", { class: "vote-row" }, [
        el("button", {
          type: "button", class: "vote-win" + (isWinner ? " is-on" : ""),
          text: isWinner ? "◉ 勝者" : "○ 勝者にする",
          "aria-pressed": String(isWinner),
          onClick: () => saveVote({ ...votes, winnerAgentId: isWinner ? null : a.id })
        }),
        el("span", { class: "vote-name " + cls, text: AGENT_SHAPES[a.shapeIndex] + " " + a.name }),
        stars
      ]));
    }

    if (votes.at) {
      box.appendChild(el("p", { class: "field-hint", text:
        "記録済み（" + new Date(votes.at).toLocaleString("ja-JP") + "）。押し直すと更新されます" }));
    } else {
      box.appendChild(el("p", { class: "field-hint", text:
        "勝者と星は独立して付けられます。AIの採点結果には影響しません" }));
    }
    root.appendChild(box);
  }

  // 判定が割れているか。理由の文字列を返す（割れていなければ null）。
  function needsHuman(j) {
    if (!j || j.raw || !Array.isArray(j.scores)) return null;
    if (j.stability?.checked && j.stability.unstable) return "ラベルを反転すると勝者が変わった";
    const sorted = [...j.scores].filter((x) => Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
    if (sorted.length >= 2) {
      const max = sorted[0].maxScore ?? 10;
      // 満点の 5%（20点満点なら1点）以内なら僅差とみなす
      if (sorted[0].score - sorted[1].score <= max * 0.05) return "上位2体の得点差が僅か";
    }
    return null;
  }

  function saveVote(next) {
    const s = state.session;
    if (!s) return;
    s.votes = { ...next, at: Date.now() };
    emit("votes:changed", s.votes);
    render(s.judgement ?? null);
  }

  on("evaluation:done", ({ judgement }) => render(judgement));
  on("session:restored", (s) => render(s.judgement));
  on("session:started", (s) => render(s.judgement ?? null));
  render(null);
}
