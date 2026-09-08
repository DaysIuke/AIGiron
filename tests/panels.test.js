// tests/panels.test.js — 判定タブ・論点タブの描画防御と、モーダル共通の振る舞い。
// インポート経路（FR-07-06）は judgement / issues の形を検証しないため、
// 壊れた形が描画まで届く。落ちずに原文へ落とすことをここで担保する。

import { group, test, ok, eq } from "./runner.js";
import { mountVerdict } from "../js/ui/verdict.js";
import { mountIssues } from "../js/ui/issues.js";
import { mountSynthesis } from "../js/ui/synthesis.js";
import { bindModal } from "../js/ui/modal.js";
import { el } from "../js/ui/dom.js";
import { state, emit, on, resetState } from "../js/state.js";
import { DEFAULTS, makeAgent } from "../js/config.js";

function session(extra = {}) {
  const agents = [makeAgent(0, "mock", "mock-1", "アルファ"),
                  makeAgent(1, "mock", "mock-1", "ベータ")];
  return {
    id: "s_panel", topic: "議題", status: "done", cursor: { round: 1, index: 0 },
    config: { ...DEFAULTS, agents }, turns: [], summaries: {}, ...extra
  };
}

// 描画対象を state に載せてから session:started を投げる（engine と同じ順序）。
function show(root, mount, s) {
  resetState();
  mount(root);
  state.session = s;
  emit("session:started", s);
}

export function run() {
  group("ui/verdict.js・ui/issues.js 壊れた判定の描画");

  test("VP-1 scores が配列でない判定は原文表示に落ち、投票UIは出る", () => {
    const root = el("div");
    show(root, mountVerdict, session({ judgement: { scores: "壊れています", summary: "x" } }));
    ok(root.querySelector(".verdict-raw"), "原文表示に落ちていない");
    ok(!root.querySelector(".verdict-row"), "採点行を描こうとしている");
    // FR-08-06: AIの採点が壊れていても人間の投票は独立して行える
    ok(root.querySelectorAll(".vote-win").length === 2, "投票UIが出ていない");
  });

  test("VP-2 正常な判定では採点行が出る", () => {
    const root = el("div");
    show(root, mountVerdict, session({
      judgement: {
        scores: [{ agentId: "a0", participant: "参加者A", score: 8, reason: "理由" },
                 { agentId: "a1", participant: "参加者B", score: 5, reason: "理由" }],
        winnerAgentId: "a0", summary: "講評"
      }
    }));
    eq(root.querySelectorAll(".verdict-row").length, 2);
    ok(!root.querySelector(".verdict-raw"), "正常なのに原文表示になっている");
    ok(root.querySelector(".verdict-winner"), "勝者が印付けされていない");
  });

  test("VP-4 打ち切って採点した場合、相関は解釈できないと明示する（D-076）", () => {
    const root = el("div");
    const s = session({
      judgement: {
        scores: [{ agentId: "a0", participant: "参加者A", score: 8, reason: "r" },
                 { agentId: "a1", participant: "参加者B", score: 4, reason: "r" }],
        winnerAgentId: "a0", summary: "講評",
        transcriptTruncated: { perTurnChars: 280 }
      },
      turns: [
        { round: 1, index: 0, agentId: "a0", role: "propose", text: "長い", chars: 900 },
        { round: 1, index: 1, agentId: "a1", role: "critique", text: "短い", chars: 100 }
      ]
    });
    show(root, mountVerdict, s);
    ok(root.textContent.includes("この相関は「審判が長さに釣られたか」を測っていません"),
      "打ち切りの注意書きが出ていない");
    ok(root.textContent.includes("280 字ずつ"), "1発言あたりの字数が出ていない");
    ok(!root.textContent.includes("冗長性バイアスの疑いがあります"),
      "打ち切ったのにバイアスありと断定している");
  });

  test("VP-4b 打ち切っていなければ従来どおりの解釈を出す", () => {
    const root = el("div");
    const s = session({
      judgement: {
        scores: [{ agentId: "a0", participant: "参加者A", score: 8, reason: "r" },
                 { agentId: "a1", participant: "参加者B", score: 4, reason: "r" }],
        winnerAgentId: "a0", summary: "講評"
      },
      turns: [
        { round: 1, index: 0, agentId: "a0", role: "propose", text: "長い", chars: 900 },
        { round: 1, index: 1, agentId: "a1", role: "critique", text: "短い", chars: 100 }
      ]
    });
    show(root, mountVerdict, s);
    ok(!root.textContent.includes("測っていません"), "打ち切っていないのに注意書きが出ている");
    ok(root.textContent.includes("相関係数:"), "相関が出ていない");
  });

  test("VP-5 不安定・僅差の判定では人間の判断を促す（B003 Human-in-the-Loop・D-078）", () => {
    const mk = (scores, stability) => session({
      judgement: { scores, winnerAgentId: "a0", summary: "s", ...(stability ? { stability } : {}) }
    });
    const sc = (a, b) => [
      { agentId: "a0", participant: "参加者A", score: a, maxScore: 20, reason: "r" },
      { agentId: "a1", participant: "参加者B", score: b, maxScore: 20, reason: "r" }
    ];
    // 不安定
    const r1 = el("div");
    show(r1, mountVerdict, mk(sc(16, 8), { checked: true, unstable: true }));
    ok(r1.textContent.includes("ラベルを反転すると勝者が変わった"), "不安定なのに促していない");

    // 僅差（20点満点で1点差 = 5%以内）
    const r2 = el("div");
    show(r2, mountVerdict, mk(sc(15, 14), null));
    ok(r2.textContent.includes("上位2体の得点差が僅か"), "僅差なのに促していない");

    // 差が大きく安定していれば出さない
    const r3 = el("div");
    show(r3, mountVerdict, mk(sc(18, 6), { checked: true, unstable: false }));
    ok(!r3.textContent.includes("この判定は割れています"), "割れていないのに促している");
  });

  test("VP-5b 既に投票済みなら促さない", () => {
    const root = el("div");
    show(root, mountVerdict, session({
      judgement: {
        scores: [{ agentId: "a0", participant: "参加者A", score: 15, maxScore: 20, reason: "r" },
                 { agentId: "a1", participant: "参加者B", score: 14, maxScore: 20, reason: "r" }],
        winnerAgentId: "a0", summary: "s"
      },
      votes: { winnerAgentId: "a0", stars: {}, at: Date.now() }
    }));
    ok(!root.textContent.includes("この判定は割れています"), "投票済みなのに促している");
  });

  test("VP-3 raw だけの判定はこれまでどおり原文で出る（AC-A15）", () => {
    const root = el("div");
    show(root, mountVerdict, session({ judgement: { raw: "壊れたJSONの原文" } }));
    eq(root.querySelector(".verdict-raw").textContent, "壊れたJSONの原文");
    ok(root.querySelector(".vote-win"), "投票UIが出ていない");
  });

  test("IP-1 issues が配列でない論点は原文表示に落ちる", () => {
    const root = el("div");
    show(root, mountIssues, session({ issues: { issues: { title: "配列ではない" } } }));
    ok(root.querySelector(".verdict-raw"), "原文表示に落ちていない");
    ok(!root.querySelector(".issue-card"), "論点カードを描こうとしている");
  });

  test("IP-2 positions が欠けた論点でも落ちずに描ける", () => {
    const root = el("div");
    show(root, mountIssues, session({
      issues: { issues: [{ title: "論点1" }, { title: "論点2", positions: [] }] }
    }));
    eq(root.querySelectorAll(".issue-card").length, 2);
    eq(root.querySelectorAll(".issue-title")[0].textContent, "論点1");
  });

  test("SY-1 answer が文字列でない結論は原文表示に落ちる（D-070）", () => {
    const root = el("div");
    show(root, mountSynthesis, session({ synthesis: { answer: { broken: true } } }));
    ok(root.querySelector(".verdict-raw"), "原文表示に落ちていない");
    ok(!root.querySelector(".synth-answer"), "結論カードを描こうとしている");
  });

  test("SY-2 正常な結論は結論カードと各節が出て、参加者名が付く", () => {
    const root = el("div");
    show(root, mountSynthesis, session({ synthesis: {
      answer: "結論です。", consensus: ["一致点"], disagreements: [{ point: "割れた", positions: "AとBで違う" }],
      unique: [{ agentId: "a1", participant: "参加者B", point: "独自の指摘" }], openQuestions: []
    } }));
    eq(root.querySelector(".synth-answer-text").textContent, "結論です。");
    eq(root.querySelectorAll(".synth-list").length, 3, "空の節（残った問い）まで出ている");
    ok(root.textContent.includes("ベータ: 独自の指摘"), "1体だけの指摘に名前が付いていない");
  });

  test("SY-4 残った問いから次の議論を始められる（FR-12-04・D-077）", () => {
    const root = el("div");
    const s = session({ synthesis: {
      answer: "評価軸を先に決めるべきである。", consensus: [], disagreements: [], unique: [],
      openQuestions: ["費用は誰が負担するか", "誰が評価軸を決めるか"]
    } });
    show(root, mountSynthesis, s);
    const buttons = [...root.querySelectorAll(".synth-next")];
    eq(buttons.length, 2, "残った問いごとにボタンが出ていない");

    let payload = null;
    on("topic:carryover", (p) => { payload = p; });
    buttons[0].click();
    eq(payload.topic, "費用は誰が負担するか", "問いが議題として渡っていない");
    eq(payload.premise.fromTopic, "議題", "前の議題が渡っていない");
    eq(payload.premise.answer, "評価軸を先に決めるべきである。", "前の結論が渡っていない");
  });

  test("SY-3 結論が無ければ案内だけ出る", () => {
    const root = el("div");
    show(root, mountSynthesis, session({}));
    ok(root.querySelector(".placeholder"), "案内が無い");
    ok(!root.querySelector(".synth-answer"), "無いのに結論カードが出ている");
  });

  group("ui/modal.js モーダル共通の振る舞い");

  test("MO-1 開いている間だけ Escape で閉じる", () => {
    const root = el("div");
    let closed = 0;
    bindModal(root, () => { closed++; root.hidden = true; });

    root.hidden = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    eq(closed, 0, "閉じているのに close が呼ばれた");

    root.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    eq(closed, 1, "Escape で閉じない");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    eq(closed, 1, "閉じた後もう一度呼ばれた");
  });

  test("MO-2 閉じたら開く前のフォーカス位置へ戻す", () => {
    const root = el("div");
    root.hidden = true;
    const modal = bindModal(root, () => {});

    const opener = el("button", { text: "開く" });
    const other = el("button", { text: "別の場所" });
    document.body.appendChild(opener);
    document.body.appendChild(other);
    try {
      opener.focus();
      modal.opened();          // 開いた時点のフォーカス（= opener）を覚える
      other.focus();           // モーダル内へ移った想定
      modal.closed();
      eq(document.activeElement, opener, "開く前のボタンへ戻っていない");
    } finally {
      opener.remove();
      other.remove();
    }
  });

  test("MO-3 覚えた要素が消えていても落ちない", () => {
    const root = el("div");
    root.hidden = true;
    const modal = bindModal(root, () => {});
    const opener = el("button", { text: "開く" });
    document.body.appendChild(opener);
    opener.focus();
    modal.opened();
    opener.remove();           // 再描画などで消えた場合
    modal.closed();            // 例外にならなければよい
    ok(true);
  });
}
