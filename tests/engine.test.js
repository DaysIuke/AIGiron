// tests/engine.test.js — 状態機械とターンループ。

import { group, atest, eq, ok, athrows } from "./runner.js";
import { createEngine, maxTokensFor } from "../js/engine.js";
import { state, resetState } from "../js/state.js";
import { createFakeClock } from "../js/clock.js";
import { DEFAULTS, makeAgent } from "../js/config.js";

// respond(agent, attemptNo, ctx) が文字列を返せば成功、投げれば失敗として扱う。
function setup({ n = 3, config = {}, respond } = {}) {
  resetState();
  const clock = createFakeClock();
  const calls = [];
  const holder = {};

  const callProvider = async (agent, ctx, opts) => {
    opts.budget.check();
    opts.budget.consume(agent.provider);
    calls.push({ agentId: agent.id, round: state.session.cursor.round });
    const text = await respond(agent, calls.length, ctx, holder);
    return { text, usage: { tokensIn: 10, tokensOut: 20 }, elapsedMs: 1 };
  };

  const engine = createEngine({
    callProvider,
    storage: { save: async () => {} },
    clock,
    summarizer: null
  });
  holder.engine = engine;

  const agents = Array.from({ length: n }, (_, i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
  const cfg = { ...DEFAULTS, agents, requestLimit: 200, ...config };
  return { engine, clock, calls, cfg, holder };
}

const okText = () => "これは検証用の発言です。";

// sleep を手動で解決できるクロック。ゾンビループの時間窓を再現する（D-033）。
function manualClock() {
  const pending = [];
  return {
    pending,
    now: () => 0,
    sleep(sec, opts = {}) {
      return new Promise((res) => pending.push({ sec, res }));
    },
    release() { const p = pending.shift(); if (p) p.res(); }
  };
}
const microtasks = () => new Promise((r) => setTimeout(r, 0));

export function run() {
  group("engine.js 議論エンジン");

  // E-1: AC-A01
  return (async () => {
    await atest("E-1 3体×3ラウンドが完走する（AC-A01）", async () => {
      const { engine, cfg } = setup({ config: { rounds: 3, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      ok(r.reason.startsWith("完走"), "完走と報告されるべき: " + r.reason);
      ok(r.reason.includes("9 件"), "発言件数が添えられるべき: " + r.reason);
      eq(r.session.turns.length, 9);
      eq(r.session.requestCount, 9);
    });

    await atest("E-2 総括ラウンドが最後に1周だけ回る", async () => {
      const { engine, cfg } = setup({ config: { rounds: 3, enableSummaryRound: true }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.session.turns.length, 12);
      const last = r.session.turns.slice(-3);
      ok(last.every((t) => t.role === "summary"), "総括ラウンドの役割が summary でない");
      ok(last.every((t) => t.round === 4), "総括ラウンドの番号が違う");
    });

    await atest("E-3 発言順はラウンド開始時に確定して保存される（RB-C2）", async () => {
      const { engine, cfg } = setup({ config: { rounds: 2, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 12345 });
      eq(Object.keys(r.session.roundOrder).sort(), ["1", "2"]);
      eq(r.session.roundOrder[1].length, 3);
      const r1 = r.session.turns.filter((t) => t.round === 1).map((t) => t.agentId);
      eq(r1, r.session.roundOrder[1], "実際の発言順が roundOrder と一致しない");
    });

    await atest("E-4 一時停止でループが止まりカーソルが残る（AC-A04）", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 3, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { if (nth === 2) h.engine.pause(); return okText(); }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "paused");
      eq(r.session.turns.length, 2);
      eq(r.session.cursor.round, 1);
      eq(r.session.cursor.index, 2);
    });

    await atest("E-5 再開すると続きから完走する（AC-A04）", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 3, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { if (nth === 2) h.engine.pause(); return okText(); }
      });
      await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const r2 = await engine.resume();
      eq(r2.status, "done");
      eq(r2.session.turns.length, 9);
      // 再開後も発言順が変わらない
      const r1ids = r2.session.turns.filter((t) => t.round === 1).map((t) => t.agentId);
      eq(r1ids, r2.session.roundOrder[1]);
    });

    await atest("E-6 停止すると stopped になる", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 3, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { if (nth === 1) h.engine.stop(); return okText(); }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "stopped");
    });

    await atest("E-7 429 で待機してから同じターンを再実行する（AC-A06）", async () => {
      let thrown = false;
      const { engine, cfg, clock } = setup({
        config: { rounds: 1, enableSummaryRound: false, maxWaitSec: 60 },
        respond: () => {
          if (!thrown) { thrown = true; throw { kind: "rate", retryAfterSec: null, message: "rate" }; }
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.session.turns.length, 3);
      ok(clock.slept.length >= 1, "待機が発生していない");
      eq(r.session.requestCount, 4, "失敗した1回も requestCount に入るべき（RB-C4）");
    });

    await atest("E-8 待機が上限を超えたら一時停止する（AC-A07）", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 1, enableSummaryRound: false, maxWaitSec: 1 },
        respond: () => { throw { kind: "rate", retryAfterSec: null, message: "rate" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "paused");
    });

    await atest("E-8b 429 が続いても累計待機の上限で必ず止まる（D-007）", async () => {
      let calls = 0;
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false, maxWaitSec: 60, requestLimit: 200 },
        respond: () => { calls++; throw { kind: "rate", retryAfterSec: null, message: "rate" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "paused", "永久に再試行し続けている");
      // backoff 2+4+8+16+16+16 = 62 > 60 で止まる
      ok(calls <= 8, "上限で止まるまでの試行が多すぎる: " + calls);
      ok(r.session.requestCount < 200, "リクエスト上限まで食い潰している");
    });

    await atest("E-8c モデル名が違う等の config エラーは即座に離脱させる（D-013）", async () => {
      let calls = 0;
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false, dropThreshold: 3 },
        respond: (a) => {
          calls++;
          if (a.id === "a0") throw { kind: "config", message: "The model does not exist" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const a0 = r.session.config.agents.find((x) => x.id === "a0");
      eq(a0.status, "dropped", "config エラーで離脱していない");
      eq(r.session.dropped[0].reason, "設定の誤り");
      // dropThreshold(3) を待たず 1 回で落ちる
      const a0Calls = r.session.errors.filter((e) => e.agentId === "a0").length;
      eq(a0Calls, 1, "再試行または複数ラウンド待ちが発生している");
      eq(r.status, "done");
      ok(r.session.turns.length > 0, "他のAIまで止まっている");
    });

    await atest("E-8d 全員が config エラーなら理由が設定の誤りだと分かる（D-013）", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false },
        respond: () => { throw { kind: "config", message: "The model does not exist" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.reason, "設定の誤りで参加AIがいなくなりました");
      eq(r.session.requestCount, 2, "3体目に進む前に止まるべき");
    });

    await atest("E-8e 413 は渡す範囲を2段階まで縮めて張り直し、それでも駄目ならセッションを止める（D-022→D-074）", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false },
        respond: () => { throw { kind: "toolarge", message: "大きすぎます" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "error");
      eq(r.reason, "コンテキストが大きすぎます");
      eq(r.session.contextShrink, 2, "2段階まで縮めてから諦めるべき");
      eq(r.session.requestCount, 3, "同じターンを縮小して2回張り直してから止まるべき（1体目のまま）");
    });

    await atest("E-8e2 413 が1回なら縮めた範囲で同じターンをやり直し、完走する（D-074）", async () => {
      const seen = [];
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false, contextRounds: 2 },
        respond: (a, nth, ctx) => {
          seen.push(ctx.user);
          if (nth === 7) throw { kind: "toolarge", message: "大きすぎます" };   // R3 の最初のターン
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.session.turns.length, 9, "発言が欠けた");
      eq(r.session.contextShrink, 1);
      eq(r.session.requestCount, 10, "張り直し1回分だけ増えるべき");
      const recentOf = (u) => (u.split("【直近の発言】")[1] ?? "").split("\n\n【")[0];
      ok(/^R1 /m.test(recentOf(seen[6])), "縮小前の R3 には R1 の全文が入っているはず");
      ok(!/^R1 /m.test(recentOf(seen[7])), "縮小後の張り直しで R1 の全文が残っている");
      ok(seen[7].includes("【これまでの議論の要約】") && seen[7].includes("R1:"), "範囲から外れた R1 が要約として渡っていない");
    });

    await atest("E-8f 出力枠不足は枠を倍にして張り直す（D-024）", async () => {
      const seenTokens = [];
      resetState();
      const clock = createFakeClock();
      let attempt = 0;
      const callProvider = async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume();
        seenTokens.push(opts.maxTokens);
        attempt++;
        if (attempt === 1) throw { kind: "budget", message: "思考で枠を使い切りました" };
        return { text: "立て直した発言", usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const agents = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents, rounds: 1, enableSummaryRound: false, requestLimit: 50, maxChars: 250 },
        seed: 1
      });
      eq(r.status, "done");
      eq(seenTokens[0], 500, "1回目は maxChars*2");
      eq(seenTokens[1], 1000, "2回目は倍になるべき");
      eq(r.session.turns.length, 2, "立て直して全員発言するべき");
    });

    await atest("E-8g 枠を広げても駄目なら失敗として数える（無限ループにしない）", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 2, enableSummaryRound: false, dropThreshold: 2, requestLimit: 60 },
        respond: () => { throw { kind: "budget", message: "空のまま" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      // 止まること自体が検証。無限ループなら here に到達しない
      ok(r.status === "done" || r.status === "paused", "終了状態: " + r.status);
      ok(r.session.requestCount < 60, "リクエスト上限まで回り続けている");
      ok(r.session.dropped.length > 0, "離脱していない");
    });

    await atest("E-8h 提供終了モデルは後継に差し替えて1度だけ張り直す（D-028）", async () => {
      resetState();
      const clock = createFakeClock();
      const seenModels = [];
      const swaps = [];
      const { on } = await import("../js/state.js");
      on("agent:model-swapped", (p) => swaps.push(p));
      const callProvider = async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume();
        seenModels.push(agent.model);
        if (agent.model === "gemini-2.5-flash") {
          throw { kind: "config", message: "no longer available", replacementModel: "gemini-3.6-flash" };
        }
        return { text: "後継モデルの発言", usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const agents = [makeAgent(0, "gemini", "gemini-2.5-flash", "G"), makeAgent(1, "mock", "mock-fast", "M")];
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents, rounds: 1, enableSummaryRound: false, requestLimit: 50, order: "fixed" },
        seed: 1
      });
      eq(r.status, "done");
      eq(seenModels[0], "gemini-2.5-flash", "最初は元のモデルで叩く");
      eq(seenModels[1], "gemini-3.6-flash", "2回目は後継で張り直す");
      eq(r.session.turns.length, 2, "差し替え後に発言が確定するべき");
      eq(r.session.dropped.length, 0, "離脱させてはいけない");
      eq(swaps.length, 1);
      eq(swaps[0].to, "gemini-3.6-flash");
    });

    await atest("E-8i 後継でも駄目なら2度目は差し替えず離脱する", async () => {
      const { engine, cfg } = setup({
        n: 2,
        config: { rounds: 1, enableSummaryRound: false },
        respond: (a) => {
          if (a.id === "a0") throw { kind: "config", message: "gone", replacementModel: "next-" + a.model };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const a0 = r.session.config.agents.find((x) => x.id === "a0");
      eq(a0.status, "dropped", "無限に差し替え続けている");
      eq(r.session.errors.filter((e) => e.agentId === "a0").length, 2, "1度だけ張り直して2度目で諦めるべき");
    });

    await atest("E-25 バックオフ中に pause→resume してもループが並走しない（D-033）", async () => {
      resetState();
      const clock = manualClock();
      let calls = 0;
      const callProvider = async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume();
        calls++;
        if (calls === 1) throw { kind: "server", message: "boom" };
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const ags = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const p1 = engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents: ags, rounds: 1, enableSummaryRound: false, order: "fixed", requestLimit: 50 },
        seed: 1
      });
      for (let i = 0; i < 50 && clock.pending.length === 0; i++) await microtasks();
      eq(clock.pending.length, 1, "バックオフ待機に入っていない");

      engine.pause();
      const r1 = await p1;
      eq(r1.status, "paused", "pause がバックオフを中断できていない");

      const r2 = await engine.resume();
      eq(r2.status, "done");
      eq(r2.session.turns.length, 2);
      const keys = r2.session.turns.map((t) => t.round + ":" + t.index);
      eq(new Set(keys).size, keys.length, "同じ位置の発言が重複している: " + keys.join(","));

      clock.release();
      await microtasks(); await microtasks();
      eq(state.session.turns.length, 2, "旧ループが目覚めて発言を書き足した");
    });

    await atest("E-26 一時停止は進行中のターンを中断せず、完了を待つ（FR-05-02）", async () => {
      resetState();
      const clock = createFakeClock();
      let release = null;
      let sawAbort = false;
      const callProvider = async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume();
        opts.signal?.addEventListener("abort", () => { sawAbort = true; });
        await new Promise((r) => { release = r; });
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const ags = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const p = engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents: ags, rounds: 1, enableSummaryRound: false, order: "fixed", requestLimit: 50 },
        seed: 1
      });
      for (let i = 0; i < 50 && !release; i++) await microtasks();
      ok(release, "ターンが始まっていない");

      engine.pause();
      eq(sawAbort, false, "pause が進行中の応答を中断している（stop だけが中断してよい）");
      const rel1 = release; release = null;
      rel1();
      const r = await p;
      eq(r.status, "paused");
      eq(r.session.turns.length, 1, "進行中だったターンは完了・確定するべき");

      const p2 = engine.resume();
      for (let i = 0; i < 50 && !release; i++) await microtasks();   // 2ターン目のゲートを待って解放する
      ok(release, "再開後のターンが始まっていない");
      release();
      const r2 = await p2;
      eq(r2.status, "done");
      eq(r2.session.turns.length, 2);
    });

    await atest("E-27 離脱は連続失敗で判定し、成功で failures がリセットされる（FR-06-05）", async () => {
      const { engine, cfg, holder } = setup({
        n: 2,
        config: { rounds: 4, enableSummaryRound: false, dropThreshold: 2, order: "fixed", requestLimit: 50 },
        respond: (a) => {
          const round = holder.engine.session.cursor.round;
          if (a.id === "a0" && round % 2 === 1) throw { kind: "unknown", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const a0 = r.session.config.agents.find((x) => x.id === "a0");
      ok(a0.status !== "dropped", "連続していない失敗の累計で離脱した");
      eq(r.session.dropped.length, 0);
    });

    await atest("E-9 連続失敗で離脱し、他は議論を続ける（AC-A08）", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false, dropThreshold: 3 },
        respond: (a) => {
          if (a.id === "a0") throw { kind: "server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const a0 = r.session.config.agents.find((a) => a.id === "a0");
      eq(a0.status, "dropped");
      eq(r.session.dropped.length, 1);
      ok(r.session.turns.every((t) => t.agentId !== "a0"), "離脱したAIの発言が混ざっている");
      ok(r.session.turns.length > 0, "他のAIの発言まで止まっている");
    });

    await atest("E-10 離脱しても roleIndex と roundOrder は変わらない（RB-C1 / RB-C2）", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 3, enableSummaryRound: false, dropThreshold: 1 },
        respond: (a) => {
          if (a.id === "a1") throw { kind: "auth_like_but_server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 7 });
      eq(r.session.config.agents.map((a) => a.roleIndex), [0, 1, 2], "roleIndex が振り直された");
      ok(r.session.roundOrder[1].includes("a1"), "離脱者が roundOrder から消えた");
    });

    await atest("E-11 参加が1体以下になったら継続不能で終了（AC-A09）", async () => {
      const { engine, cfg } = setup({
        n: 2,
        config: { rounds: 3, enableSummaryRound: false, dropThreshold: 1 },
        respond: (a) => {
          if (a.id === "a0") throw { kind: "server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.reason, "参加AIが1体以下になった");
    });

    await atest("E-12 対立型で陣営が全滅したら終了する（AC-A10）", async () => {
      const agents = [0, 1, 2, 3].map((i) => {
        const a = makeAgent(i, "mock", "mock-fast", "AI" + i);
        a.stance = i % 2 === 0 ? "for" : "against";
        return a;
      });
      const { engine, cfg } = setup({
        n: 4,
        config: { rounds: 3, enableSummaryRound: false, dropThreshold: 1, format: "debate", agents },
        respond: (a) => {
          if (a.stance === "for") throw { kind: "server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.reason, "賛成側が全滅した");
    });

    await atest("E-13 推定が上限を超える設定は開始を拒否する（AC-A11）", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 5, enableSummaryRound: true, requestLimit: 10 },
        respond: okText
      });
      await athrows(() => engine.start({ topic: "議題", config: cfg, seed: 1 }),
        "上限超過なのに開始できてしまった");
      eq(state.status, "idle");
    });

    await atest("E-14 実行中に上限へ達したら一時停止する", async () => {
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 2, enableSummaryRound: false, requestLimit: 8, dropThreshold: 99 },
        respond: (a) => {
          if (a.id === "a0") throw { kind: "server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "paused");
      eq(r.session.requestCount, 8, "上限ちょうどで止まっていない");
    });

    await atest("E-14b 上限到達のメッセージが「再開しても進まない」ことを案内する", async () => {
      // E-14 と同じ形（開始時の見積りは通るが、実行中の再試行で上限に達する）。
      const { engine, cfg } = setup({
        n: 3,
        config: { rounds: 2, enableSummaryRound: false, requestLimit: 8, dropThreshold: 99 },
        respond: (a) => {
          if (a.id === "a0") throw { kind: "server", message: "boom" };
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "paused");
      const err = r.session.errors.find((e) => e.kind === "limit");
      ok(err, "limit エラーが記録されていない");
      ok(err.message.includes("上限を上げてから再開"), "案内文が入っていない: " + err.message);
    });

    await atest("E-14c rate のバックオフと server の再試行カウンタは独立している（レビュー）", async () => {
      // rate を1回はさんでから server を2回はさみ、4回目で成功させる。
      // 共有カウンタのままだと rate 分の消費で server 側の再試行枠（3回）を早く使い切り、
      // 4回目（本来なら成功するはず）に到達する前に諦めてしまう。
      let n = 0;
      const { engine, cfg } = setup({
        n: 2,
        config: { rounds: 1, enableSummaryRound: false, dropThreshold: 2, maxWaitSec: 60, order: "fixed" },
        respond: (a) => {
          if (a.id !== "a0") return okText();
          n++;
          if (n === 1) throw { kind: "rate", retryAfterSec: null, message: "rate" };   // agent.retries を消費
          if (n === 2 || n === 3) throw { kind: "server", message: "boom" };            // transientRetries 1,2回目
          return okText();   // 4回目（transientRetries的には3回目の試行）は成功する
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      const a0 = r.session.config.agents.find((x) => x.id === "a0");
      eq(n, 4, "4回目（本来成功するはず）に到達していない。rate 分の消費で早期に諦めた可能性がある");
      eq(a0.status, "idle", "成功しているのに error/dropped のままになっている");
      ok(r.session.turns.some((t) => t.agentId === "a0"), "a0 の発言が確定していない");
      eq(r.status, "done");
    });

    await atest("E-15 空応答は再試行され、成功すれば議論が続く（RB-M1）", async () => {
      let firstEmpty = false;
      const { engine, cfg } = setup({
        config: { rounds: 1, enableSummaryRound: false },
        respond: () => {
          if (!firstEmpty) { firstEmpty = true; throw { kind: "empty", message: "空応答" }; }
          return okText();
        }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "done");
      eq(r.session.turns.length, 3);
      eq(r.session.requestCount, 4);
    });

    await atest("E-16 auth は復帰不能として error で止まる", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 2, enableSummaryRound: false },
        respond: () => { throw { kind: "auth", message: "Invalid API key" }; }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.status, "error");
      eq(r.reason, "APIキーが不正です");
    });

    await atest("E-17 完走後の start は新しいセッションを作る（RI-M8）", async () => {
      const { engine, cfg } = setup({ config: { rounds: 1, enableSummaryRound: false }, respond: okText });
      const r1 = await engine.start({ topic: "議題A", config: cfg, seed: 1 });
      const id1 = r1.session.id;
      const r2 = await engine.start({ topic: "議題B", config: cfg, seed: 2 });
      eq(r2.session.topic, "議題B");
      eq(r2.session.turns.length, 3, "前のセッションの発言が残っている");
      ok(r2.session.seed !== r1.session.seed || r2.session.id !== id1, "同じセッションを使い回している");
    });

    await atest("E-18 提案役が2ラウンド連続で同じAIにならない（AC-A02）", async () => {
      const { engine, cfg } = setup({ config: { rounds: 6, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 99 });
      let prev = null;
      for (let round = 1; round <= 6; round++) {
        const p = r.session.turns.find((t) => t.round === round && t.role === "propose");
        ok(p, "R" + round + " に提案役がいない");
        ok(p.agentId !== prev, "R" + round + " で提案役が連続した");
        prev = p.agentId;
      }
    });

    await atest("E-19 要約は contextRounds を過ぎたラウンドについて作られる", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 4, enableSummaryRound: false, contextRounds: 2 },
        respond: okText
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      // R3完了時に R1、R4完了時に R2 の要約が作られる
      eq(Object.keys(r.session.summaries).sort(), ["1", "2"]);
      ok(typeof r.session.summaries[1] === "string" && r.session.summaries[1].length > 0,
        "Summarizer 未接続でも切り詰めで埋まるべき");
    });

    await atest("E-21 出力上限で切れた発言は turn に記録される（D-020）", async () => {
      resetState();
      const clock = createFakeClock();
      const callProvider = async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume();
        return { text: "途中で切れた発言", usage: {}, finishReason: "length", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const agents = [0, 1, 2].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents, rounds: 1, enableSummaryRound: false, requestLimit: 50 },
        seed: 1
      });
      ok(r.session.turns.every((t) => t.truncated === true), "truncated が記録されていない");
    });

    await atest("E-22 maxTokens は maxChars から導かれる（D-018）", async () => {
      eq(maxTokensFor(400), 800);
      eq(maxTokensFor(150), 300);
      eq(maxTokensFor(50), 256, "下限で丸められるべき");
      eq(maxTokensFor(2000), 2000, "上限で丸められるべき");
    });

    await atest("E-24 持ち回り型では各ラウンドの最初の発言が提案役になる（D-031）", async () => {
      const { engine, cfg } = setup({ n: 4, config: { rounds: 4, enableSummaryRound: true, order: "random" }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 2024 });
      for (let round = 1; round <= 4; round++) {
        const first = r.session.turns.find((t) => t.round === round && t.index === 0);
        eq(first.role, "propose", "R" + round + " の先頭が提案役でない: " + first.role);
      }
      // 総括ラウンドは全員 summary なので固定しない
      const sum = r.session.turns.filter((t) => t.round === 5);
      ok(sum.every((t) => t.role === "summary"), "総括ラウンドの役割が違う");
      // 先頭以外はランダム化が効いている（4ラウンドで1回でも順序が変わる）
      const tails = [1, 2, 3, 4].map((rd) => r.session.roundOrder[rd].slice(1).join());
      ok(new Set(tails).size > 1, "先頭以外の順序が固定されている");
    });

    await atest("E-28 審判が有効なら完走後に採点され、requestCount に算入される（FR-09/15-05）", async () => {
      resetState();
      const clock = createFakeClock();
      let judgeCalls = 0;
      const callProvider = async (agent, ctx, opts) => {
        opts.budget?.check(); opts.budget?.consume(agent.provider);
        if (agent.id === "judge") {
          judgeCalls++;
          if (ctx.user.includes("審判")) {
            return { text: JSON.stringify({
              scores: [{ participant: "参加者A", score: 6, reason: "r" },
                       { participant: "参加者B", score: 7, reason: "r" }],
              winner: "参加者B", summary: "講評" }) };
          }
          return { text: JSON.stringify({ issues: [{ title: "論点", positions: [] }] }) };
        }
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const ags = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents: ags, rounds: 1, enableSummaryRound: false, order: "fixed",
                  requestLimit: 50, judge: { enabled: true, provider: "mock", model: "mock-fast" } },
        seed: 1
      });
      eq(r.status, "done");
      eq(judgeCalls, 2, "採点と論点で2回のはず");
      eq(r.session.requestCount, 4, "討論2 + 審判2 が requestCount に入るべき");
      eq(r.session.judgement.winnerAgentId, "a1");
      eq(r.session.issues.issues[0].title, "論点");
    });

    await atest("E-29 審判が失敗しても議論は完走扱いになる", async () => {
      resetState();
      const clock = createFakeClock();
      const callProvider = async (agent, ctx, opts) => {
        opts.budget?.check(); opts.budget?.consume(agent.provider);
        if (agent.id === "judge") throw { kind: "server", message: "審判ダウン" };
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const ags = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const r = await engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents: ags, rounds: 1, enableSummaryRound: false, order: "fixed",
                  requestLimit: 50, judge: { enabled: true, provider: "mock", model: "mock-fast" } },
        seed: 1
      });
      eq(r.status, "done", "審判の失敗で議論まで壊れてはいけない");
      ok(r.reason.startsWith("完走"), "完走扱いになるべき: " + r.reason);
    });

    await atest("E-30 審判の評価中に stop() しても『完走』へ上書きされない（多角レビューで発見）", async () => {
      // レビュー: 審判評価中は while ループの外（await runEvaluation の間）なので
      //   state.status===\"running\" の再チェックが効かず、stop() で \"stopped\" になった
      //   後も評価が完了すると黙って \"done\" に上書きされていた。加えて signal を渡して
      //   いなかったため stop() の ac.abort() が審判のフェッチを中断できなかった。
      resetState();
      const clock = createFakeClock();
      let releaseJudge;
      const gate = new Promise((res) => { releaseJudge = res; });
      const holder = {};
      const callProvider = async (agent, ctx, opts) => {
        opts.budget?.check(); opts.budget?.consume(agent.provider);
        if (agent.id === "judge") {
          holder.signal = opts.signal;
          await gate;
          if (opts.signal?.aborted) throw { kind: "aborted", message: "aborted" };
          return { text: JSON.stringify({ issues: [{ title: "t", positions: [] }] }) };
        }
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      };
      const engine = createEngine({ callProvider, storage: { save: async () => {} }, clock });
      const ags = [0, 1].map((i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
      const p = engine.start({
        topic: "議題",
        config: { ...DEFAULTS, agents: ags, rounds: 1, enableSummaryRound: false, order: "fixed",
                  requestLimit: 50, judge: { enabled: true, provider: "mock", model: "mock-fast" } },
        seed: 1
      });
      for (let i = 0; i < 50 && !holder.signal; i++) await microtasks();
      ok(holder.signal, "審判の呼び出しに signal が渡っていない");
      engine.stop();
      eq(state.status, "stopped", "stop() は即座に反映されるべき");
      ok(holder.signal.aborted, "stop() が審判のリクエストを中断していない");
      releaseJudge();
      const r = await p;
      eq(r.status, "stopped", "審判の完了で stopped が done に上書きされた");
    });

    // D-062: 離脱・役割再構築・発言順の相互作用を、条件を振って総当たりで確かめる。
    //   個別ケース（E-9〜E-12・E-24 等）は点の確認なので、組み合わせで崩れないことを別途押さえる。
    await atest("E-32 参加数・ラウンド数・離脱タイミングを振っても不変条件が崩れない", async () => {
      const violations = [];
      for (const n of [2, 3, 4, 5]) {
        for (const rounds of [1, 2, 3]) {
          for (const failAt of [1, 2, 3, 5, 8]) {
            resetState();
            let calls = 0;
            const failing = "a" + (failAt % n);
            const callProvider = async (agent, ctx, opts) => {
              opts.budget.check(); opts.budget.consume(agent.provider); calls++;
              if (agent.id === failing && calls >= failAt) throw { kind: "server", message: "落ちる" };
              return { text: "発言。", usage: {}, finishReason: "stop", elapsedMs: 1 };
            };
            const engine = createEngine({
              callProvider, storage: { save: async () => {} }, clock: createFakeClock()
            });
            const ags = Array.from({ length: n }, (_, i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
            const label = "n=" + n + " r=" + rounds + " f=" + failAt;
            let res;
            try {
              res = await engine.start({
                topic: "不変条件の確認",
                config: { ...DEFAULTS, agents: ags, rounds, enableSummaryRound: true, order: "random",
                          requestLimit: 500, dropThreshold: 3, maxWaitSec: 60,
                          judge: { enabled: false, provider: null, model: null } },
                seed: n * 100 + rounds
              });
            } catch (e) { violations.push(label + " 例外: " + e.message); continue; }

            const s = res.session;
            const keys = s.turns.map((t) => t.round + ":" + t.index);
            if (new Set(keys).size !== keys.length) violations.push(label + " 同じ位置の発言が二重");
            const ri = s.config.agents.map((a) => a.roleIndex).join(",");
            if (ri !== Array.from({ length: n }, (_, i) => i).join(",")) {
              violations.push(label + " roleIndex が変化: " + ri);
            }
            if (!["done", "stopped", "error"].includes(res.status)) {
              violations.push(label + " 状態が終端でない: " + res.status);
            }
            for (const [round, p] of Object.entries(s.proposers ?? {})) {
              if (!s.config.agents.find((x) => x.roleIndex === p)) {
                violations.push(label + " R" + round + " の提案役が存在しない roleIndex=" + p);
              }
            }
          }
        }
      }
      eq(violations, [], "不変条件の違反: " + violations.join(" / "));
    });

    group("engine.js 司会の差し込みと追加ラウンド（FR-05-07 / FR-05-08・D-070）");

    await atest("E-33 一時停止中に差し込んだ司会の文が、再開後の次の発言のコンテキストに入る", async () => {
      const seen = [];
      const { engine, cfg, holder } = setup({
        config: { rounds: 2, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { seen.push(ctx.user); if (nth === 2) h.engine.pause(); return okText(); }
      });
      await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(state.status, "paused");
      const t = engine.interject("費用の見積りを示してください");
      ok(t && t.agentId === "human" && t.role === "moderator", "司会の発言として積まれていない");
      ok(t.index < 0, "司会の index はAIのターン位置と衝突しない負数のはず: " + t.index);
      const r = await engine.resume();
      eq(r.status, "done");
      ok(seen[2].includes("【司会からの指示・質問】") && seen[2].includes("費用の見積りを示してください"),
        "再開後の発言に司会の文が渡っていない");
      ok(!seen[1].includes("【司会からの指示・質問】"), "差し込む前の発言に司会の文がある");
      eq(r.session.turns.filter((x) => x.agentId === "human").length, 1);
      eq(r.session.turns.filter((x) => x.agentId !== "human").length, 6, "AIの発言数が変わった");
    });

    await atest("E-33b 実行中の差し込みは受け付けない（進行中のコンテキストと保存点を崩さない）", async () => {
      let result = "未実行";
      const { engine, cfg } = setup({
        config: { rounds: 1, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { if (nth === 1) result = h.engine.interject("割り込み"); return okText(); }
      });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(result, null, "実行中なのに受け付けた");
      eq(r.session.turns.filter((x) => x.agentId === "human").length, 0);
      eq(engine.interject("   "), null, "空文字を受け付けた");
    });

    await atest("E-34 完走後にラウンドを足すと、古い総括と評価を捨てて続きから完走し、最後に総括を作り直す", async () => {
      const { engine, cfg } = setup({ config: { rounds: 2, enableSummaryRound: true }, respond: okText });
      const r1 = await engine.start({ topic: "議題", config: cfg, seed: 7 });
      eq(r1.status, "done");
      eq(r1.session.turns.length, 9);   // 3体 × (2 + 総括)
      const r2 = await engine.extend(1);
      eq(r2.status, "done");
      eq(r2.session.config.rounds, 3);
      eq(r2.session.turns.length, 12, "3ラウンド＋総括で 12 件のはず");
      const summary = r2.session.turns.filter((t) => t.role === "summary");
      eq(summary.length, 3, "総括が二重になっている");
      ok(summary.every((t) => t.round === 4), "総括が最後のラウンドに無い");
      ok(r2.session.turns.slice(0, 6).every((t) => t.round <= 2), "元の発言が消えた");
      eq(r2.session.requestCount, 15);
    });

    await atest("E-34b 実行中・一時停止中は追加できない", async () => {
      const { engine, cfg } = setup({
        config: { rounds: 2, enableSummaryRound: false },
        respond: (a, nth, ctx, h) => { if (nth === 2) h.engine.pause(); return okText(); }
      });
      await engine.start({ topic: "議題", config: cfg, seed: 1 });
      await athrows(() => engine.extend(1), "一時停止中に追加できてしまった");
    });

    await atest("E-34c リクエスト上限を超える追加は拒み、状態を壊さない", async () => {
      const { engine, cfg } = setup({ config: { rounds: 1, enableSummaryRound: false, requestLimit: 4 }, respond: okText });
      const r1 = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r1.status, "done");
      await athrows(() => engine.extend(1), "上限を超えるのに追加できた");
      eq(state.status, "done", "拒んだのに状態が変わった");
      eq(r1.session.config.rounds, 1, "拒んだのにラウンド数が変わった");
    });

    await atest("E-34d 完走後に差し込んでから足すと、追加ラウンドの発言に司会の文が渡る", async () => {
      const seen = [];
      const { engine, cfg } = setup({
        config: { rounds: 1, enableSummaryRound: false, contextRounds: 2 },
        respond: (a, nth, ctx) => { seen.push(ctx.user); return okText(); }
      });
      await engine.start({ topic: "議題", config: cfg, seed: 1 });
      ok(engine.interject("次は反例を挙げてください"), "終了後の差し込みが拒まれた");
      const r = await engine.extend(1);
      eq(r.status, "done");
      ok(seen.slice(3).every((u) => u.includes("次は反例を挙げてください")), "追加ラウンドの発言に司会の文が無い");
    });

    await atest("E-35 開始時の一言は司会の発言として積まれ、最初の発言から参照される（FR-12-05・D-077）", async () => {
      const seen = [];
      const { engine, cfg } = setup({
        n: 2, config: { rounds: 1, enableSummaryRound: false },
        respond: (a, nth, ctx) => { seen.push(ctx.user); return okText(); }
      });
      const r = await engine.start({
        topic: "議題", config: cfg, seed: 1, note: "費用の観点を必ず入れてください"
      });
      eq(r.status, "done");
      const human = r.session.turns.filter((t) => t.agentId === "human");
      eq(human.length, 1, "司会の発言が積まれていない");
      eq(human[0].round, 1);
      ok(human[0].index < 0, "AIのターン位置と衝突しない負数のはず");
      ok(seen[0].includes("【司会からの指示・質問】") && seen[0].includes("費用の観点を必ず入れてください"),
        "1体目の発言に司会の一言が渡っていない");
      eq(r.session.turns.filter((t) => t.agentId !== "human").length, 2, "AIの発言数が変わった");
    });

    await atest("E-35b 一言が空なら司会の発言は積まれない", async () => {
      const { engine, cfg } = setup({ n: 2, config: { rounds: 1, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1, note: "   " });
      eq(r.session.turns.filter((t) => t.agentId === "human").length, 0);
    });

    await atest("E-36 引き継いだ前提はセッションに載り、全員のコンテキストに入る（FR-12-04・D-077）", async () => {
      const seen = [];
      const { engine, cfg } = setup({
        n: 2, config: { rounds: 1, enableSummaryRound: false },
        respond: (a, nth, ctx) => { seen.push(ctx.user); return okText(); }
      });
      const premise = { fromTopic: "前の議題", question: "残った問い", answer: "前の結論。" };
      const r = await engine.start({ topic: "残った問い", config: cfg, seed: 1, premise });
      eq(r.session.premise.fromTopic, "前の議題", "セッションに前提が載っていない");
      ok(seen.every((u) => u.includes("前の結論。")), "全員に前提が渡っていない");
    });

    await atest("E-36b 前提を渡さなければ null のまま", async () => {
      const { engine, cfg } = setup({ n: 2, config: { rounds: 1, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "議題", config: cfg, seed: 1 });
      eq(r.session.premise, null);
    });

    await atest("E-20 議題は500字で切られる（AC-A05）", async () => {
      const { engine, cfg } = setup({ config: { rounds: 1, enableSummaryRound: false }, respond: okText });
      const r = await engine.start({ topic: "あ".repeat(600), config: cfg, seed: 1 });
      eq(r.session.topic.length, 500);
    });
  })();
}
