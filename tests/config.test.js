// tests/config.test.js — config.js の純粋関数（推定リクエスト数まわり）。

import { group, test, eq, ok } from "./runner.js";
import { estimateRequests, DEFAULTS, expandSolo, makeAgent, DEFAULT_PERSONAS } from "../js/config.js";

function cfg(over = {}) {
  return { ...DEFAULTS, agents: [1, 2, 3], rounds: 3, enableSummaryRound: true, ...over };
}

export function run() {
  group("config.js estimateRequests");

  test("Q-1 審判なしは 参加数 × (ラウンド数＋総括) だけ", () => {
    eq(estimateRequests(cfg({ judge: { enabled: false } })), 3 * 4);
  });

  // FR-08-01 で審判を既定ONにしたため、provider/model が未設定のうちは加算しない
  //   （engine の実行条件 enabled && provider && model と揃える）。
  const JUDGE = { provider: "mock", model: "mock-fast" };

  test("Q-2 審判ありは +2（採点＋論点）", () => {
    eq(estimateRequests(cfg({ judge: { ...JUDGE, enabled: true, checkStability: false } })), 3 * 4 + 2);
  });

  test("Q-3 安定性チェックも有効なら +1 さらに増える（FR-08-07）", () => {
    eq(estimateRequests(cfg({ judge: { ...JUDGE, enabled: true, checkStability: true } })), 3 * 4 + 3);
  });

  test("Q-2c 議長の統合をONにすると +1（FR-08-09・D-070）", () => {
    eq(estimateRequests(cfg({ judge: { ...JUDGE, enabled: true, synthesize: true } })), 3 * 4 + 3);
    eq(estimateRequests(cfg({ judge: { ...JUDGE, enabled: true, synthesize: true, checkStability: true } })), 3 * 4 + 4);
    eq(DEFAULTS.judge.synthesize, true, "統合は既定ONのはず");
  });

  test("Q-4 審判が無効なら checkStability が true でも加算しない", () => {
    eq(estimateRequests(cfg({ judge: { ...JUDGE, enabled: false, checkStability: true } })), 3 * 4);
  });

  test("Q-4b 審判ONでも provider/model 未設定なら加算しない（実際には走らないため）", () => {
    eq(estimateRequests(cfg({ judge: { enabled: true, provider: null, model: null } })), 3 * 4,
      "走らない審判の分まで見積りに載せている");
    eq(estimateRequests(cfg({ judge: { enabled: true, provider: "mock", model: null } })), 3 * 4,
      "モデル未設定なのに加算している");
  });

  test("Q-4c 審判は既定ON（FR-08-01）", () => {
    eq(DEFAULTS.judge.enabled, true, "要件は既定ONだが既定OFFになっている");
  });

  test("Q-5 総括ラウンド無しはラウンド数だけ", () => {
    eq(estimateRequests(cfg({ enableSummaryRound: false, judge: { enabled: false } })), 3 * 3);
  });

  group("config.js expandSolo（FR-03-09 ソロ議論モード）");

  test("Q-6 solo.enabled が false ならそのまま返す", () => {
    const agents = [makeAgent(0, "groq", "m", "AI")];
    eq(expandSolo(agents, { enabled: false, count: 3 }), agents);
  });

  test("Q-7 参加AIが1体以外ならソロが有効でも展開しない", () => {
    const agents = [makeAgent(0, "groq", "m", "AI1"), makeAgent(1, "groq", "m", "AI2")];
    eq(expandSolo(agents, { enabled: true, count: 3 }), agents);
  });

  test("Q-8 参加AIが1体・ソロ有効なら count 体に展開し、同一プロバイダ・モデルを共有する", () => {
    const base = makeAgent(0, "groq", "openai/gpt-oss-20b", "ソロAI");
    const expanded = expandSolo([base], { enabled: true, count: 3 });
    eq(expanded.length, 3);
    ok(expanded.every((a) => a.provider === "groq" && a.model === "openai/gpt-oss-20b"),
      "全員が同じプロバイダ・モデルを共有していない");
    eq(expanded.map((a) => a.id), ["a0", "a1", "a2"], "id が連番で振り直されていない");
    eq(expanded.map((a) => a.roleIndex), [0, 1, 2]);
    eq(expanded.map((a) => a.colorIndex), [0, 1, 2], "見た目（色）が別々に振られていない");
    ok(expanded.every((a) => a.persona), "全員にペルソナが設定されていない");
    const uniquePersonas = new Set(expanded.map((a) => a.persona));
    eq(uniquePersonas.size, 3, "ペルソナが被っている");
  });

  test("Q-9 count は 2〜4 に丸められる", () => {
    const base = makeAgent(0, "groq", "m", "AI");
    eq(expandSolo([base], { enabled: true, count: 1 }).length, 2, "下限が効いていない");
    eq(expandSolo([base], { enabled: true, count: 99 }).length, DEFAULT_PERSONAS.length,
      "既定ペルソナ数を超えて展開できてしまっている");
  });

  test("Q-10 カスタムペルソナを渡せば既定を使わない", () => {
    const base = makeAgent(0, "groq", "m", "AI");
    const custom = ["独自ペルソナ1", "独自ペルソナ2"];
    const expanded = expandSolo([base], { enabled: true, count: 2, personas: custom });
    eq(expanded.map((a) => a.persona), custom);
  });

  test("Q-11 ペルソナ数が count と一致しなければ既定に戻す（食い違ったカスタムを使わない）", () => {
    const base = makeAgent(0, "groq", "m", "AI");
    const expanded = expandSolo([base], { enabled: true, count: 3, personas: ["1個だけ"] });
    eq(expanded.map((a) => a.persona), DEFAULT_PERSONAS.slice(0, 3));
  });
}
