// tests/stats.test.js — 保存済みセッションの横断集計（FR-07-08・D-078）。

import { group, test, eq, ok } from "./runner.js";
import { aggregate, modelKey, pct, MIN_RELIABLE } from "../js/stats.js";

// 最小限のセッション。agents は provider/model/id だけ見ている。
function sess({ id = "s", agents, judge = null, winner = null, scores = null,
                votes = null, stability = null, raw = false } = {}) {
  const s = {
    id, topic: "t", status: "done", cursor: { round: 1, index: 0 },
    config: { agents, judge }, turns: [], votes
  };
  s.judgement = raw ? { raw: "壊れた" } : {
    scores: scores ?? agents.map((a) => ({ agentId: a.id, score: 10, maxScore: 20, reason: "r" })),
    winnerAgentId: winner, summary: "s", ...(stability ? { stability } : {})
  };
  return s;
}
const A = (id, provider, model) => ({ id, provider, model, name: id, roleIndex: 0 });

export function run() {
  group("stats.js 横断集計（FR-07-08・D-078）");

  test("ST-A1 空でも落ちない", () => {
    const a = aggregate([]);
    eq(a.total, 0); eq(a.judged, 0); eq(a.models, []); eq(a.judges, []);
    eq(aggregate(null).total, 0, "null でも落ちてはいけない");
  });

  test("ST-A2 モックが混ざるセッションは丸ごと除く（実モデルの傾向を汚さない）", () => {
    const real = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const withMock = [A("a0", "groq", "m1"), A("a1", "mock", "mock-fast")];
    const a = aggregate([
      sess({ id: "1", agents: real, judge: { provider: "groq", model: "m1" }, winner: "a0" }),
      sess({ id: "2", agents: withMock, judge: { provider: "groq", model: "m1" }, winner: "a0" }),
      // 討論者は実モデルでも審判がモックなら採点が意味を持たない
      sess({ id: "3", agents: real, judge: { provider: "mock", model: "mock-fast" }, winner: "a0" })
    ]);
    eq(a.total, 3);
    eq(a.mockSkipped, 2, "モックが絡む2件を除くべき");
    eq(a.judged, 1);
    ok(!a.models.some((m) => m.key.startsWith("mock")), "モックが行に出ている");
  });

  test("ST-A3 構造化できなかった採点（raw）は集計に入れない", () => {
    const agents = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const a = aggregate([
      sess({ id: "1", agents, judge: { provider: "groq", model: "m1" }, winner: "a0" }),
      sess({ id: "2", agents, judge: { provider: "groq", model: "m1" }, raw: true })
    ]);
    eq(a.judged, 1, "raw は数えない");
  });

  test("ST-A4 モデル別の出場・AI勝率・平均得点", () => {
    const agents = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const a = aggregate([
      sess({ id: "1", agents, judge: { provider: "groq", model: "m1" }, winner: "a0",
             scores: [{ agentId: "a0", score: 16, maxScore: 20 }, { agentId: "a1", score: 8, maxScore: 20 }] }),
      sess({ id: "2", agents, judge: { provider: "groq", model: "m1" }, winner: "a1",
             scores: [{ agentId: "a0", score: 12, maxScore: 20 }, { agentId: "a1", score: 10, maxScore: 20 }] })
    ]);
    const groq = a.models.find((m) => m.key === "groq / m1");
    eq(groq.appearances, 2);
    eq(groq.aiWins, 1);
    eq(groq.aiWinRate, 0.5);
    eq(groq.avgScore, 0.7, "(16/20 + 12/20) / 2 = 0.7");
  });

  test("ST-A5 満点が違う採点（旧10点満点と新20点満点）を正規化して混ぜられる", () => {
    const agents = [A("a0", "groq", "m1")];
    const a = aggregate([
      sess({ id: "1", agents, judge: { provider: "groq", model: "m1" },
             scores: [{ agentId: "a0", score: 8, maxScore: 10 }] }),
      sess({ id: "2", agents, judge: { provider: "groq", model: "m1" },
             scores: [{ agentId: "a0", score: 12, maxScore: 20 }] })
    ]);
    eq(a.models[0].avgScore, 0.7, "(0.8 + 0.6) / 2 = 0.7");
  });

  test("ST-A6 人間投票とAI判定の一致率（B001 の agreement rate 相当）", () => {
    const agents = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const j = { provider: "groq", model: "m1" };
    const a = aggregate([
      sess({ id: "1", agents, judge: j, winner: "a0", votes: { winnerAgentId: "a0", stars: {} } }),
      sess({ id: "2", agents, judge: j, winner: "a0", votes: { winnerAgentId: "a1", stars: {} } }),
      // 投票が無い回・星だけの回は母数に入れない
      sess({ id: "3", agents, judge: j, winner: "a0" }),
      sess({ id: "4", agents, judge: j, winner: "a0", votes: { winnerAgentId: null, stars: { a0: 5 } } })
    ]);
    const g = a.judges[0];
    eq(g.sessions, 4);
    eq(g.agreeBoth, 2, "勝者が両方にある回だけが母数");
    eq(g.agreeSame, 1);
    eq(g.agreeRate, 0.5);
    eq(a.voted, 2, "勝者を投票した回数");
  });

  test("ST-A7 自己贔屓は「審判と同じモデルが参加していた回」を母数にする（B009）", () => {
    const j = { provider: "groq", model: "m1" };
    const withSelf = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const without = [A("a0", "mistral", "m3"), A("a1", "gemini", "m2")];
    const a = aggregate([
      sess({ id: "1", agents: withSelf, judge: j, winner: "a0" }),   // 自分と同じモデルが勝った
      sess({ id: "2", agents: withSelf, judge: j, winner: "a1" }),
      sess({ id: "3", agents: without, judge: j, winner: "a0" })     // 同じモデルがいない → 母数外
    ]);
    const g = a.judges[0];
    eq(g.selfCases, 2);
    eq(g.selfWins, 1);
    eq(g.selfWinRate, 0.5);
  });

  test("ST-A8 安定性は「チェックした回」を母数にする（既定OFFなので未チェックが多い）", () => {
    const agents = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const j = { provider: "groq", model: "m1" };
    const a = aggregate([
      sess({ id: "1", agents, judge: j, winner: "a0", stability: { checked: true, unstable: true } }),
      sess({ id: "2", agents, judge: j, winner: "a0", stability: { checked: true, unstable: false } }),
      sess({ id: "3", agents, judge: j, winner: "a0", stability: { checked: false, reason: "x" } }),
      sess({ id: "4", agents, judge: j, winner: "a0" })
    ]);
    const g = a.judges[0];
    eq(g.stabilityChecked, 2, "checked:false と未実施は母数に入れない");
    eq(g.stabilityUnstable, 1);
    eq(g.unstableRate, 0.5);
  });

  test("ST-A9 母数が0なら割合は null。0% と書かない", () => {
    const agents = [A("a0", "groq", "m1")];
    const a = aggregate([sess({ id: "1", agents, judge: { provider: "groq", model: "m1" } })]);
    eq(a.models[0].humanWinRate, null, "投票が無いのに 0% と出してはいけない");
    eq(a.models[0].avgStars, null);
    eq(a.judges[0].agreeRate, null);
    eq(pct(null), "—");
    eq(pct(0.5), "50%");
    eq(pct(0), "0%", "母数があって 0 なら 0% は正しい");
  });

  test("ST-A10 件数が少ないうちは reliable が false", () => {
    const agents = [A("a0", "groq", "m1")];
    const j = { provider: "groq", model: "m1" };
    const few = Array.from({ length: MIN_RELIABLE - 1 }, (_, i) => sess({ id: "s" + i, agents, judge: j }));
    eq(aggregate(few).reliable, false);
    const enough = Array.from({ length: MIN_RELIABLE }, (_, i) => sess({ id: "s" + i, agents, judge: j }));
    eq(aggregate(enough).reliable, true);
  });

  test("ST-A12 採点が無い回の理由を数える（D-083）", () => {
    // 理由を出さないと「0 セッション」としか見えない。実際に審判ありで回したのに
    // レート制限で採点が落ち、集計に何も入らず原因が分からなかった（D-082）。
    const agents = [A("a0", "groq", "m1"), A("a1", "gemini", "m2")];
    const j = { enabled: true, provider: "groq", model: "m1" };
    const base = { id: "x", topic: "t", status: "done", cursor: { round: 1, index: 0 }, turns: [] };
    const a = aggregate([
      sess({ id: "1", agents, judge: j, winner: "a0" }),                       // 集計に入る
      { ...base, id: "2", config: { agents, judge: j }, judgement: { failed: "採点に失敗: 429" } },
      { ...base, id: "3", config: { agents, judge: j }, judgement: { raw: "JSONではない" } },
      { ...base, id: "4", config: { agents, judge: { enabled: false } }, judgement: null },
      { ...base, id: "5", config: { agents, judge: j }, judgement: null }      // 途中停止など
    ]);
    eq(a.judged, 1);
    eq(a.excluded.failed, 1, "失敗した回が数えられていない");
    eq(a.excluded.unstructured, 1, "構造化できなかった回が数えられていない");
    eq(a.excluded.noJudge, 1, "審判未設定の回が数えられていない");
    eq(a.excluded.other, 1, "その他の回が数えられていない");
  });

  test("ST-A12b 全部集計に入るなら除外はすべて0", () => {
    const agents = [A("a0", "groq", "m1")];
    const j = { enabled: true, provider: "groq", model: "m1" };
    const a = aggregate([sess({ id: "1", agents, judge: j }), sess({ id: "2", agents, judge: j })]);
    eq(a.judged, 2);
    eq(a.excluded, { failed: 0, unstructured: 0, noJudge: 0, other: 0 });
  });

  test("ST-A11 modelKey はプロバイダとモデルの組で作る", () => {
    eq(modelKey({ provider: "groq", model: "m1" }), "groq / m1");
    eq(modelKey({}), "? / ?", "欠けていても壊れない");
  });
}
