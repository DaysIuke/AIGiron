// tests/judge.test.js — 審判の匿名化・プロンプト・実行。

import { group, test, atest, eq, ok } from "./runner.js";
import { anonymize, renderAnonymous, anonymousTranscript, judgePrompt, issuesPrompt, synthesisPrompt,
         judgeBiasWarning, mockMixWarning, runEvaluation, lengthScoreCorrelation,
         consensusRate, mindChanges, CRITERIA, SCORE_MAX, JUDGE_TRANSCRIPT_CHARS } from "../js/judge.js";
import { DEFAULTS, makeAgent } from "../js/config.js";

function makeSession() {
  const agents = [
    makeAgent(0, "groq", "openai/gpt-oss-20b", "グロック"),
    makeAgent(1, "gemini", "gemini-3.6-flash", "ジェミニ")
  ];
  return {
    topic: "テストは一律で実施すべきか", seed: 1,
    config: { ...DEFAULTS, agents, rounds: 1 },
    turns: [
      { round: 1, index: 0, agentId: "a0", role: "propose", text: "一律であるべきだ。" },
      { round: 1, index: 1, agentId: "a1", role: "critique", text: "環境差を無視できない。" }
    ]
  };
}

export async function run() {
  group("judge.js 審判");

  test("JD-1 発言者は匿名化され、名前もモデル名も審判に渡らない（B003/B009）", () => {
    const s = makeSession();
    const { map } = anonymize(s);
    const prompt = judgePrompt(s, map);
    ok(prompt.includes("参加者A"), "匿名ラベルがない");
    ok(prompt.includes("参加者B"), "匿名ラベルがない");
    ok(!prompt.includes("グロック"), "名前が漏れている");
    ok(!prompt.includes("gpt-oss"), "モデル名が漏れている");
    ok(!prompt.includes("gemini"), "モデル名が漏れている");
    ok(prompt.includes("発言の長さではなく"), "長さバイアス対策（B010）の指示がない");
  });

  test("JD-2 匿名化した議論全文に発言が含まれる", () => {
    const s = makeSession();
    const { map } = anonymize(s);
    const text = renderAnonymous(s, map);
    ok(text.includes("参加者A（提案役）: 一律であるべきだ。"));
    ok(text.includes("参加者B（批判役）: 環境差を無視できない。"));
    ok(issuesPrompt(s, map).includes("論点"), "論点プロンプトが変");
  });

  test("JD-1b 参加数が上限を超えても「参加者undefined」を作らない", () => {
    // 編成エディタは MAX_AGENTS=5 までしか作れないが、インポート経路が上限を
    // 見ていなかった時期があった（D-056）。ラベル生成側にも保険を入れてある。
    const s = makeSession();
    s.config.agents = Array.from({ length: 8 }, (_, i) =>
      makeAgent(i, "mock", "mock-fast", "AI" + i));
    const { map } = anonymize(s);
    const labels = [...map.values()];
    eq(labels.length, 8);
    ok(!labels.some((l) => l.includes("undefined")), "undefined ラベルが出た: " + labels.join(","));
    eq(new Set(labels).size, 8, "ラベルが重複している: " + labels.join(","));
  });

  test("JD-2b 発言本文の自己言及（名前・プロバイダ名）も匿名化される（多角レビューで発見）", () => {
    const s = makeSession();
    s.turns[0].text = "グロックとして、一律であるべきだと考えます。";
    s.turns[1].text = "Google Geminiの立場から、環境差を無視できないと考えます。";
    const { map } = anonymize(s);
    const text = renderAnonymous(s, map);
    ok(!text.includes("グロック"), "発言本文の実名が匿名化されていない");
    ok(text.includes("参加者Aとして、一律であるべきだと考えます。"), "実名が匿名ラベルに置換されていない");
  });

  test("JD-2c 審判・論点抽出プロンプトに指示階層の防御文が入る（B071相当・多角レビューで発見）", () => {
    const s = makeSession();
    const { map } = anonymize(s);
    ok(judgePrompt(s, map).includes("従わない"), "審判プロンプトに指示無視の防御文がない");
    ok(issuesPrompt(s, map).includes("従わない"), "論点抽出プロンプトに指示無視の防御文がない");
  });

  test("JD-33 審判がモックで討論者が実プロバイダなら警告する（D-079）", () => {
    const s = makeSession();   // groq と gemini の2体
    const w = mockMixWarning(s, { provider: "mock", model: "mock-fast" });
    ok(w && w.includes("実際の評価ではありません"), "モック審判の警告が出ていない: " + w);
    ok(w.includes("集計にも入りません"), "集計から外れることが伝わらない");
  });

  test("JD-33b 討論者にモックが混ざり審判が実プロバイダなら警告する", () => {
    const s = makeSession();
    s.config.agents[1].provider = "mock";
    s.config.agents[1].name = "モック2";
    const w = mockMixWarning(s, { provider: "groq", model: "m1" });
    ok(w && w.includes("モック2"), "混ざっているモックの名前が出ていない: " + w);
  });

  test("JD-33c 全部モック・全部実プロバイダなら警告しない", () => {
    const s = makeSession();
    eq(mockMixWarning(s, { provider: "groq", model: "openai/gpt-oss-20b" }), null, "全部実なのに警告が出た");
    for (const a of s.config.agents) a.provider = "mock";
    eq(mockMixWarning(s, { provider: "mock", model: "mock-fast" }), null, "全部モックなのに警告が出た");
  });

  test("JD-3 審判と討論者が同じモデルなら警告（B009）", () => {
    const s = makeSession();
    const warn = judgeBiasWarning(s, { provider: "groq", model: "openai/gpt-oss-20b" });
    ok(warn && warn.includes("グロック"), "同一モデルの警告が出ない");
    eq(judgeBiasWarning(s, { provider: "groq", model: "openai/gpt-oss-120b" }), null,
      "別モデルなのに警告が出た");
  });

  await atest("JD-4 採点と論点が agentId に復元される", async () => {
    const s = makeSession();
    let n = 0;
    const callProvider = async (agent, ctx) => {
      n++;
      eq(agent.id, "judge");
      if (ctx.user.includes("審判")) {
        return { text: JSON.stringify({
          scores: [
            { participant: "参加者A", score: 7, reason: "根拠が具体的" },
            { participant: "参加者B", score: 8, reason: "反論が的確" }
          ],
          winner: "参加者B", summary: "良い議論だった"
        }) };
      }
      return { text: JSON.stringify({
        issues: [{ title: "公平性の定義",
          positions: [
            { participant: "参加者A", stance: "形式的平等" },
            { participant: "参加者B", stance: "実質的公平" }
          ] }]
      }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(n, 2, "採点と論点で2リクエストのはず");
    eq(out.error, null);
    eq(out.judgement.winnerAgentId, "a1");
    eq(out.judgement.scores.find((x) => x.agentId === "a0").score, 7);
    eq(out.issues.issues[0].positions.find((p) => p.agentId === "a1").stance, "実質的公平");
  });

  await atest("JD-5 構造化に全滅しても raw で残り、エラーにしない（AC-A15）", async () => {
    const s = makeSession();
    const callProvider = async () => ({ text: "JSONにしません" });
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(out.error, null);
    eq(out.judgement.raw, "JSONにしません");
    eq(out.issues.raw, "JSONにしません");
  });

  await atest("JD-6 スコアは 0〜10 に丸められる", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("審判")) {
        return { text: JSON.stringify({
          scores: [
            { participant: "参加者A", score: 15, reason: "過大" },
            { participant: "参加者B", score: -3, reason: "過小" }
          ],
          winner: null, summary: "s"
        }) };
      }
      return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(out.judgement.scores[0].score, 10);
    eq(out.judgement.scores[1].score, 0);
    eq(out.judgement.winnerAgentId, null, "引き分けは null のはず");
  });

  group("judge.js 審判に渡す議論の上限とレート耐性（D-075）");

  // 長い議論を作る。1発言 500 字 × 20 発言 = 1万字。
  function longSession(turns = 20, chars = 500) {
    const s = makeSession();
    s.turns = Array.from({ length: turns }, (_, i) => ({
      round: Math.floor(i / 2) + 1, index: i % 2,
      agentId: i % 2 ? "a1" : "a0", role: i % 2 ? "critique" : "propose",
      text: (i % 2 ? "ブラボーの発言" : "アルファの発言") + i + "。" + "あ".repeat(chars)
    }));
    return s;
  }

  test("JD-29 上限を超える議論は全発言が同じ長さで打ち切られる（誰も丸ごと落とさない）", () => {
    const s = longSession();
    const { map } = anonymize(s);
    const full = anonymousTranscript(s, map, 0);
    eq(full.truncated, false, "上限0なら打ち切らない");

    const tr = anonymousTranscript(s, map, 3000);
    ok(tr.truncated, "上限を超えているのに打ち切られていない");
    ok(tr.text.length < full.text.length, "短くなっていない");
    // 20発言すべてが残っている（発言を落とすと落とされた側が不当に低く採点される）
    eq((tr.text.match(/^R\d+ /gm) ?? []).length, 20, "発言が落ちている");
    ok(tr.text.includes("参加者A") && tr.text.includes("参加者B"), "参加者が消えた");
    // 打ち切りの長さが揃っている
    const lens = tr.text.split("\n\n").map((l) => l.length);
    ok(Math.max(...lens) - Math.min(...lens) <= 4, "打ち切りの長さが揃っていない: " + lens.join(","));
  });

  test("JD-29b 打ち切ったときはプロンプトに「短さを理由に減点しない」注記が入る", () => {
    const s = longSession();
    const { map } = anonymize(s);
    const cut = judgePrompt(s, map, 3000);
    ok(cut.includes("途中で終わっていることを理由に減点しない"), "注記が無い");
    const notCut = judgePrompt(makeSession(), map, JUDGE_TRANSCRIPT_CHARS);
    ok(!notCut.includes("途中で終わっていることを理由に減点しない"), "短い議論なのに注記が出ている");
    // 論点・統合のプロンプトにも効く
    ok(issuesPrompt(s, map, 3000).length < issuesPrompt(s, map, 0).length, "論点プロンプトに上限が効いていない");
    ok(synthesisPrompt(s, map, 3000).length < synthesisPrompt(s, map, 0).length, "統合プロンプトに上限が効いていない");
  });

  await atest("JD-30 審判の 429 は待って張り直す（討論で枠を使い切った直後を想定）", async () => {
    const s = makeSession();
    const slept = [];
    let n = 0;
    const callProvider = async (agent, ctx) => {
      n++;
      if (n <= 2) throw { kind: "rate", retryAfterSec: 8, message: "TPM" };
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 6, reason: "r" }], winner: "参加者B", summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {},
      sleep: async (sec) => { slept.push(sec); }
    });
    eq(out.error, null, "429 を待てば通るのに失敗扱いになっている");
    eq(slept, [9, 9], "APIの指示（8秒）＋1秒で待つべき");
    eq(out.judgement.winnerAgentId, "a1");
  });

  await atest("JD-35 呼び出しが失敗したら null ではなく failed として残す（D-081）", async () => {
    // null のままだと画面が「まだ結論がありません。設定で有効にしてください」と出す。
    // 有効にしてあるのにそう言われるので、利用者は原因に辿り着けない（実際に踏んだ）。
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("議長")) throw { kind: "server", message: "落ちた" };
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {}
    });
    ok(out.synthesis && out.synthesis.failed, "失敗が null のままになっている");
    ok(out.synthesis.failed.includes("統合に失敗"), "何が失敗したか分からない: " + out.synthesis.failed);
    ok(out.synthesis.failed.includes("落ちた"), "理由が入っていない");
    ok(Array.isArray(out.judgement.scores), "採点まで巻き添えになっている");
    ok(out.error && out.error.includes("統合に失敗"), "error にも出るべき");
  });

  await atest("JD-35b 採点・論点が失敗したときも failed として残す", async () => {
    const s = makeSession();
    const callProvider = async () => { throw { kind: "server", message: "全部落ちた" }; };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {}
    });
    ok(out.judgement?.failed?.includes("採点に失敗"), "採点の失敗が残っていない");
    ok(out.issues?.failed?.includes("論点抽出に失敗"), "論点の失敗が残っていない");
    ok(out.synthesis?.failed?.includes("統合に失敗"), "統合の失敗が残っていない");
  });

  await atest("JD-30b 待機が上限を超えたら諦める。他の呼び出しは巻き添えにしない", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("審判")) throw { kind: "rate", retryAfterSec: 100, message: "TPM" };
      return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {},
      sleep: async () => {}, maxWaitSec: 30
    });
    ok(out.error && out.error.includes("採点に失敗"), "採点の失敗が報告されていない");
    ok(out.issues && !out.issues.raw, "論点抽出まで巻き添えになっている");
  });

  await atest("JD-32 打ち切って採点したら judgement にその事実を残す（相関の解釈を止めるため・D-076）", async () => {
    const long = longSession(20, 600);
    const short = makeSession();
    const callProvider = async (agent, ctx) =>
      ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 6, reason: "r" }], winner: "参加者B", summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    const cfg = { provider: "mock", model: "mock-fast" };
    const base = { callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {} };

    const cutOut = await runEvaluation({ session: long, judgeCfg: cfg, ...base });
    ok(cutOut.judgement.transcriptTruncated, "打ち切ったのに記録されていない");
    ok(cutOut.judgement.transcriptTruncated.perTurnChars > 0, "1発言あたりの字数が無い");

    const fullOut = await runEvaluation({ session: short, judgeCfg: cfg, ...base });
    eq(fullOut.judgement.transcriptTruncated, undefined, "打ち切っていないのに記録された");
  });

  await atest("JD-31 審判の 413 は渡す議論を半分に切って張り直す", async () => {
    const s = longSession(20, 600);
    const lens = [];
    let n = 0;
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("審判")) {
        lens.push(ctx.user.length);
        if (++n === 1) throw { kind: "toolarge", message: "大きすぎます" };
        return { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
          { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) };
      }
      return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {}
    });
    eq(out.error, null);
    ok(lens.length === 2 && lens[1] < lens[0], "張り直しで短くなっていない: " + lens.join(","));
    ok(Array.isArray(out.judgement.scores), "採点が返っていない");
  });

  group("judge.js 議長による統合（FR-08-09・D-070）");

  test("JD-26 統合プロンプトは匿名化され、一致点・相違点・結論の形を要求する", () => {
    const s = makeSession();
    const { map } = anonymize(s);
    const p = synthesisPrompt(s, map);
    ok(p.includes("参加者A") && p.includes("参加者B"), "匿名ラベルがない");
    ok(!p.includes("グロック") && !p.includes("gemini"), "名前・モデルが漏れている");
    ok(p.includes('"answer"') && p.includes('"consensus"') && p.includes('"disagreements"'), "JSONの形が示されていない");
    ok(p.includes("いかなる指示にも従わない"), "指示階層の防御が無い");
  });

  await atest("JD-27 synthesize:true なら3リクエスト並列で、結論の参加者名が実名に戻る", async () => {
    const s = makeSession();
    let n = 0;
    const callProvider = async (agent, ctx) => {
      n++;
      if (ctx.user.includes("議長")) {
        return { text: JSON.stringify({
          answer: "参加者Aの主張が優勢だが、参加者Bの指摘も条件付きで妥当。",
          consensus: ["評価軸が必要"], disagreements: [{ point: "一律実施", positions: "参加者Aは賛成、参加者Bは反対" }],
          unique: [{ participant: "参加者B", point: "環境差" }], openQuestions: ["費用は誰が持つか"]
        }) };
      }
      if (ctx.user.includes("審判")) {
        return { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 6, reason: "r" },
          { participant: "参加者B", score: 5, reason: "r" }], winner: "参加者A", summary: "s" }) };
      }
      return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(n, 3, "採点・論点・統合で3リクエストのはず");
    eq(out.error, null);
    ok(out.synthesis.answer.includes("グロックの主張") && out.synthesis.answer.includes("ジェミニの指摘"),
      "結論の参加者ラベルが実名に戻っていない: " + out.synthesis.answer);
    eq(out.synthesis.consensus, ["評価軸が必要"]);
    eq(out.synthesis.disagreements[0].positions, "グロックは賛成、ジェミニは反対");
    eq(out.synthesis.unique[0].agentId, "a1");
    eq(out.synthesis.openQuestions, ["費用は誰が持つか"]);
  });

  await atest("JD-34 一致点や相違点のキーが無い統合応答も受け付ける（D-080）", async () => {
    // 実運用で踏んだ: 一致点が無いとモデルは空配列を返さずキーごと落とす。
    // 以前は consensus / disagreements を必須にしていたため検証が落ち、
    // 2回再要求したうえで生テキスト送りになり、結論タブと書き出しから統合が丸ごと消えていた。
    const s = makeSession();
    let synthCalls = 0;
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("議長")) {
        synthCalls++;
        return { text: JSON.stringify({ answer: "評価軸を先に決めるべきである。" }) };   // 他のキーは無し
      }
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {}
    });
    eq(synthCalls, 1, "1回で通るはず（再要求で無駄にリクエストを使わない）");
    ok(!out.synthesis.raw, "生テキスト送りになっている");
    eq(out.synthesis.answer, "評価軸を先に決めるべきである。");
    eq(out.synthesis.consensus, [], "欠けたキーは空配列として扱うべき");
    eq(out.synthesis.disagreements, []);
    eq(out.synthesis.openQuestions, []);
  });

  await atest("JD-34b answer が空文字なら受け付けない（空の結論カードを描かせない）", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("議長")) return { text: JSON.stringify({ answer: "   " }) };
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}, sleep: async () => {}
    });
    ok(out.synthesis.raw, "空の answer を通してしまっている");
  });

  await atest("JD-27b synthesize が無ければ従来どおり2リクエストで synthesis は null", async () => {
    const s = makeSession();
    let n = 0;
    const callProvider = async (agent, ctx) => {
      n++;
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(n, 2);
    eq(out.synthesis, null);
  });

  await atest("JD-27c 統合だけJSONにならなくても raw で残り、採点は生きる（AC-A15）", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("議長")) return { text: "統合はJSONにしません" };
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", synthesize: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(out.synthesis.raw, "統合はJSONにしません");
    ok(Array.isArray(out.judgement.scores), "採点まで巻き添えになっている");
  });

  test("JD-28 司会（人間）の差し込みは匿名化せず「司会（人間・採点対象外）」として渡る（FR-05-07）", () => {
    const s = makeSession();
    s.turns.push({ round: 1, index: -1, agentId: "human", role: "moderator", text: "根拠を数字で示して" });
    const { map } = anonymize(s);
    const text = renderAnonymous(s, map);
    ok(text.includes("司会（人間・採点対象外）: 根拠を数字で示して"), "司会の行が無い: " + text);
    ok(!text.includes("undefined"), "司会がラベル未解決で undefined になっている");
    const p = judgePrompt(s, map);
    ok(!p.includes("参加者C"), "司会が参加者として数えられている");
  });

  group("judge.js 審判");

  await atest("JD-7 採点と論点抽出は並列に実行される（D-036）", async () => {
    const s = makeSession();
    const started = [];
    const gates = [];
    const callProvider = async (agent, ctx) => {
      started.push(ctx.user.includes("審判") ? "採点" : "論点");
      await new Promise((res) => gates.push(res));   // 両方が呼ばれるまで誰も解決しない
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const p = runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    // マイクロタスクを回して両方が呼ばれるのを待つ
    for (let i = 0; i < 20 && started.length < 2; i++) await Promise.resolve();
    eq(started.length, 2, "直列実行だと採点が終わるまで論点抽出が呼ばれない");
    gates.forEach((g) => g());
    await p;
  });

  await atest("JD-8 審判のモデルが提供終了なら後継に切り替えて張り直す（D-036）", async () => {
    const s = makeSession();
    const logs = [];
    const callProvider = async (agent, ctx) => {
      if (agent.model === "gemini-2.5-flash") {
        throw { kind: "config", message: "no longer available", replacementModel: "gemini-3.6-flash" };
      }
      eq(agent.model, "gemini-3.6-flash", "後継以外のモデルで叩かれた");
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "gemini", model: "gemini-2.5-flash" },
      callProvider, budget: null, getKey: () => "", onLog: (m) => logs.push(m)
    });
    eq(out.swappedModel, "gemini-3.6-flash");
    eq(out.error, null, "後継への切り替えが失敗として扱われている");
    eq(out.judgement.scores.length, 2);
    ok(logs.some((m) => m.includes("gemini-3.6-flash に切り替えて張り直します")),
      "切り替えのログが出ていない");
  });

  test("JD-9 anonymize は reversed でラベル割り当てだけを逆にする（FR-08-07）", () => {
    const s = makeSession();
    const { map: normal } = anonymize(s);
    const { map: reversed } = anonymize(s, { reversed: true });
    eq(normal.get("a0"), "参加者A");
    eq(normal.get("a1"), "参加者B");
    eq(reversed.get("a0"), "参加者B", "反転してもラベル割り当てが変わっていない");
    eq(reversed.get("a1"), "参加者A");
    // 発言内容・発言順自体は変えない
    ok(renderAnonymous(s, reversed).includes("一律であるべきだ。"), "発言内容が変わっている");
  });

  await atest("JD-10 checkStability:false なら安定性チェックの追加呼び出しをしない", async () => {
    const s = makeSession();
    let calls = 0;
    const callProvider = async (agent, ctx) => {
      calls++;
      return ctx.user.includes("審判")
        ? { text: JSON.stringify({ scores: [{ participant: "参加者A", score: 5, reason: "r" },
            { participant: "参加者B", score: 5, reason: "r" }], winner: null, summary: "s" }) }
        : { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", checkStability: false },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(calls, 2, "checkStability OFF なのに追加で呼ばれている");
    eq(out.judgement.stability, undefined, "OFFなのに stability フィールドが付いた");
  });

  await atest("JD-11 checkStability:true で反転しても勝者が同じなら安定と判定する", async () => {
    const s = makeSession();
    let scoreCalls = 0;
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      scoreCalls++;
      // 「発言内容」で判断する審判を模す。a1の発言（"環境差を無視できない。"）に
      // 付いているラベルを勝者にする。反転してもラベルの追跡先は a1 のままになるはず。
      const m = /(参加者[A-E])（[^）]*）: 環境差を無視できない。/.exec(ctx.user);
      ok(m, "a1の発言が見つからない: " + ctx.user);
      const winnerLabel = m[1];
      const otherLabel = winnerLabel === "参加者A" ? "参加者B" : "参加者A";
      return { text: JSON.stringify({
        scores: [{ participant: otherLabel, score: 5, reason: "r" },
                 { participant: winnerLabel, score: 8, reason: "r" }],
        winner: winnerLabel, summary: "s"
      }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", checkStability: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(scoreCalls, 2, "通常採点＋反転採点で2回のはず");
    eq(out.judgement.winnerAgentId, "a1");
    eq(out.judgement.stability?.checked, true);
    eq(out.judgement.stability?.unstable, false, "内容で一貫して同じ発言者を選んでいるのに不安定と判定された");
    eq(out.judgement.stability?.reversedWinnerAgentId, "a1");
  });

  await atest("JD-12 checkStability:true で反転すると勝者が変わるなら不安定と判定する", async () => {
    const s = makeSession();
    let scoreCalls = 0;
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      scoreCalls++;
      // 常に「参加者A」を勝者にする。反転時は a1 が参加者Aを名乗るため、
      // 通常時の勝者(a0)と反転時の勝者(a1)が食い違う＝不安定になるはず。
      return { text: JSON.stringify({
        scores: [{ participant: "参加者A", score: 8, reason: "r" }, { participant: "参加者B", score: 3, reason: "r" }],
        winner: "参加者A", summary: "s"
      }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", checkStability: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(scoreCalls, 2);
    eq(out.judgement.winnerAgentId, "a0", "通常時は参加者A=a0が勝者のはず");
    eq(out.judgement.stability?.checked, true);
    eq(out.judgement.stability?.unstable, true, "ラベルで勝者が変わったのに安定と判定された");
    eq(out.judgement.stability?.reversedWinnerAgentId, "a1", "反転時は参加者A=a1になるはず");
  });

  await atest("JD-12b 通常・反転の両方で勝者ラベルが解決できない場合は「安定」と誤判定せず checked:false にする（多角レビューで発見）", async () => {
    const s = makeSession();
    let scoreCalls = 0;
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      scoreCalls++;
      // 審判が実在しないラベル表記（表記ゆれ）を返し続けるケースを模す。
      // 旧実装は winnerAgentId が両方 null になり null!==null=false で「安定」と誤判定していた。
      return { text: JSON.stringify({
        scores: [{ participant: "参加者A", score: 8, reason: "r" }, { participant: "参加者B", score: 3, reason: "r" }],
        winner: "参加者Aさん", summary: "s"
      }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast", checkStability: true },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(scoreCalls, 2);
    eq(out.judgement.winnerAgentId, null, "解決できないラベルなのに勝者が付いた");
    eq(out.judgement.stability?.checked, false, "ラベル未解決なのに「確認済み」扱いになった");
    ok(!out.judgement.stability?.unstable, "checked:false のとき unstable は真であるべきではない");
  });

  group("judge.js lengthScoreCorrelation（FR-08-08）");

  test("JD-13 長さと得点が完全に比例していれば相関係数はほぼ1", () => {
    const s = {
      judgement: { scores: [{ agentId: "a0", score: 2 }, { agentId: "a1", score: 5 }, { agentId: "a2", score: 8 }] },
      turns: [
        { agentId: "a0", chars: 50 }, { agentId: "a1", chars: 150 }, { agentId: "a2", chars: 250 }
      ]
    };
    const corr = lengthScoreCorrelation(s);
    ok(corr, "相関が計算されない");
    eq(corr.points.length, 3);
    ok(corr.r > 0.99, "強い正の相関のはずが: " + corr.r);
  });

  test("JD-14 参加者が1人しかいない・得点が無い場合は null", () => {
    eq(lengthScoreCorrelation({ judgement: null, turns: [] }), null);
    eq(lengthScoreCorrelation({ judgement: { scores: [{ agentId: "a0", score: 5 }] }, turns: [{ agentId: "a0", chars: 100 }] }), null,
      "参加者1人なのに計算された");
  });

  test("JD-15 発言が無い参加者は相関の対象から外れる", () => {
    const s = {
      judgement: { scores: [{ agentId: "a0", score: 5 }, { agentId: "a1", score: 7 }, { agentId: "a2", score: 3 }] },
      turns: [{ agentId: "a0", chars: 100 }, { agentId: "a1", chars: 200 }]   // a2 は離脱等で発言0
    };
    const corr = lengthScoreCorrelation(s);
    ok(corr, "相関が計算されない");
    eq(corr.points.length, 2, "発言0のa2まで含まれている");
  });

  group("judge.js 観点別採点（FR-08-04/05）");

  const criteriaScores = (parts) => parts.map((pt, i) => ({
    participant: pt,
    criteria: { logic: 4 - i, evidence: 3, rebuttal: 5 - i, originality: 2 },
    reasons: { logic: "論理の理由", evidence: "根拠の理由", rebuttal: "反論の理由", originality: "独自性の理由" }
  }));

  test("JD-17 プロンプトに4観点と観点ごとの理由の指示が入る", () => {
    const s = makeSession();
    const { map } = anonymize(s);
    const p = judgePrompt(s, map);
    for (const k of CRITERIA) ok(p.includes(k), "観点 " + k + " がプロンプトに無い");
    ok(p.includes("論理の一貫性") && p.includes("根拠の具体性") &&
       p.includes("反論への対応") && p.includes("独自性"), "観点の日本語名が無い");
    ok(p.includes("reasons"), "観点ごとの理由（FR-08-05）の指示が無い");
  });

  await atest("JD-18 観点別の点数が保持され、合計が score になる（各5点満点・計20点）", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      return { text: JSON.stringify({
        scores: criteriaScores(["参加者A", "参加者B"]), winner: "参加者A", summary: "s" }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    const a0 = out.judgement.scores.find((x) => x.agentId === "a0");
    eq(a0.criteria, { logic: 4, evidence: 3, rebuttal: 5, originality: 2 });
    eq(a0.score, 14, "合計が観点の和になっていない");
    eq(a0.maxScore, SCORE_MAX, "満点が20になっていない");
    eq(a0.reasons.logic, "論理の理由", "観点ごとの理由が落ちている");
  });

  await atest("JD-19 観点の点数は0〜5に丸められる", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      return { text: JSON.stringify({
        scores: [{ participant: "参加者A", criteria: { logic: 99, evidence: -4, rebuttal: 3, originality: 2 } },
                 { participant: "参加者B", criteria: { logic: 1, evidence: 1, rebuttal: 1, originality: 1 } }],
        winner: null, summary: "s" }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    const a0 = out.judgement.scores.find((x) => x.agentId === "a0");
    eq(a0.criteria.logic, 5, "上限で丸められていない");
    eq(a0.criteria.evidence, 0, "下限で丸められていない");
  });

  await atest("JD-20 観点を返さない審判（旧形式）でも単一scoreとして受け付ける", async () => {
    // 厳しくしすぎると旧形式を返すモデルで採点が丸ごと生テキスト送りになるため、
    // 両方の形を受け付ける設計にしている。
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (!ctx.user.includes("審判")) return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
      return { text: JSON.stringify({
        scores: [{ participant: "参加者A", score: 7, reason: "旧形式" },
                 { participant: "参加者B", score: 5, reason: "旧形式" }],
        winner: "参加者A", summary: "s" }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    eq(out.judgement.raw, undefined, "旧形式が生テキスト送りになっている");
    const a0 = out.judgement.scores.find((x) => x.agentId === "a0");
    eq(a0.score, 7);
    eq(a0.maxScore, 10, "旧形式は10点満点として扱うべき");
    eq(a0.criteria, null, "観点が無いのに作られている");
  });

  group("judge.js 合意度と意見変更（FR-09-03/FR-09-04）");

  test("JD-21 合意度は agreement が true の論点の割合", () => {
    const s = { issues: { issues: [
      { title: "A", agreement: true }, { title: "B", agreement: false },
      { title: "C", agreement: true }, { title: "D", agreement: false }
    ] } };
    const c = consensusRate(s);
    eq(c.agreed, 2); eq(c.total, 4); eq(c.rate, 0.5);
  });

  test("JD-22 agreement を返さない論点は母数から外す", () => {
    const s = { issues: { issues: [
      { title: "A", agreement: true }, { title: "B", agreement: null }, { title: "C" }
    ] } };
    const c = consensusRate(s);
    eq(c.total, 1, "真偽の無い論点まで数えている");
    eq(c.rate, 1);
    eq(consensusRate({ issues: { issues: [{ title: "A" }] } }), null,
      "全部が判定不能なら null のはず");
  });

  test("JD-23 論点が無ければ合意度は null", () => {
    eq(consensusRate({}), null);
    eq(consensusRate({ issues: { issues: [] } }), null);
  });

  await atest("JD-24 mindChanges が agentId に復元され、重複は1件に寄せる", async () => {
    const s = makeSession();
    const callProvider = async (agent, ctx) => {
      if (ctx.user.includes("審判")) {
        return { text: JSON.stringify({ scores: criteriaScores(["参加者A", "参加者B"]),
                                        winner: null, summary: "s" }) };
      }
      return { text: JSON.stringify({
        issues: [{ title: "t", agreement: true, positions: [] }],
        mindChanges: [{ participant: "参加者A", count: 2 },
                      { participant: "参加者A", count: 9 },   // 重複
                      { participant: "参加者B", count: 0 },
                      { participant: "参加者Z", count: 3 }]   // 実在しないラベル
      }) };
    };
    const out = await runEvaluation({
      session: s, judgeCfg: { provider: "mock", model: "mock-fast" },
      callProvider, budget: null, getKey: () => "", onLog: () => {}
    });
    const mc = mindChanges({ issues: out.issues });
    eq(mc.length, 2, "重複や未解決ラベルが混ざっている: " + JSON.stringify(mc));
    eq(mc.find((m) => m.agentId === "a0").count, 2, "先勝ちになっていない");
    eq(mc.find((m) => m.agentId === "a1").count, 0);
  });

  test("JD-25 mindChanges が無ければ null", () => {
    eq(mindChanges({}), null);
    eq(mindChanges({ issues: { issues: [] } }), null);
  });

  test("JD-16 審判が同じ参加者を重複して返しても1点に正規化する（多角レビューで発見）", () => {
    const s = {
      judgement: { scores: [
        { agentId: "a0", score: 2 }, { agentId: "a0", score: 9 },   // 重複（表記ゆれ等）
        { agentId: "a1", score: 5 }
      ] },
      turns: [{ agentId: "a0", chars: 100 }, { agentId: "a1", chars: 200 }]
    };
    const corr = lengthScoreCorrelation(s);
    ok(corr, "相関が計算されない");
    eq(corr.points.length, 2, "重複した a0 が2点として数えられている");
    eq(corr.points.find((p) => p.agentId === "a0").score, 2, "先勝ちで最初のスコアが使われていない");
  });
}
