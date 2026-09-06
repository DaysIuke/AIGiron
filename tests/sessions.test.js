// tests/sessions.test.js — IndexedDB 永続化と復元。

import { group, atest, eq, ok } from "./runner.js";
import { sessionsStorage } from "../js/storage/sessions.js";
import { createEngine } from "../js/engine.js";
import { state, resetState, on } from "../js/state.js";
import { createFakeClock } from "../js/clock.js";
import { DEFAULTS, makeAgent } from "../js/config.js";

const okText = () => "これは検証用の発言です。";

function agents(n) {
  return Array.from({ length: n }, (_, i) => makeAgent(i, "mock", "mock-fast", "AI" + i));
}

function blank(id, extra) {
  return {
    id, seed: 1, createdAt: 1, updatedAt: 1, status: "done", topic: id,
    config: { ...DEFAULTS, agents: [], rounds: 1 },
    roundOrder: {}, turns: [], summaries: {}, cursor: { round: 1, index: 0 },
    dropped: [], requestCount: 0, errors: [], ...extra
  };
}

export async function run() {
  group("storage/sessions.js IndexedDB");

  await sessionsStorage.clearAll();

  await atest("S-1 save → get で同じ内容が戻る", async () => {
    await sessionsStorage.save(blank("s_a", { updatedAt: 10, topic: "A", config: { agents: agents(2), rounds: 1 } }));
    const back = await sessionsStorage.get("s_a");
    eq(back.topic, "A");
    eq(back.config.agents.length, 2);
  });

  await atest("S-2 list は updatedAt 降順", async () => {
    await sessionsStorage.save(blank("s_b", { updatedAt: 30 }));
    await sessionsStorage.save(blank("s_c", { updatedAt: 20, status: "stopped" }));
    eq((await sessionsStorage.list()).map((s) => s.id), ["s_b", "s_c", "s_a"]);
  });

  await atest("S-3 findUnfinished は running / waiting / paused だけを拾う", async () => {
    eq(await sessionsStorage.findUnfinished(), null, "未完了が無いのに拾った");
    await sessionsStorage.save(blank("s_p", { updatedAt: 40, status: "paused" }));
    eq((await sessionsStorage.findUnfinished())?.id, "s_p");
  });

  await atest("S-4 remove で消える", async () => {
    await sessionsStorage.remove("s_p");
    eq(await sessionsStorage.get("s_p"), null);
    eq(await sessionsStorage.findUnfinished(), null);
  });

  group("engine.restore 復元");

  await atest("S-5 実行中に保存されたセッションは paused で復元され、続きから完走する（AC-A13/A14）", async () => {
    await sessionsStorage.clearAll();
    resetState();
    const clock = createFakeClock();
    let n = 0;
    const holder = {};
    const callProvider = async (agent, ctx, opts) => {
      opts.budget.check(); opts.budget.consume();
      n++;
      // 4ターン目の応答中に「ブラウザが閉じた」ことにする。確定前に止める
      if (n === 4) { holder.engine.stop(); throw { kind: "aborted" }; }
      return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
    };
    const engine = createEngine({ callProvider, storage: sessionsStorage, clock });
    holder.engine = engine;
    await engine.start({
      topic: "復元テスト",
      config: { ...DEFAULTS, agents: agents(3), rounds: 2, enableSummaryRound: false, requestLimit: 50, order: "random" },
      seed: 777
    });
    const id = state.session.id;
    const r1Before = state.session.roundOrder[1].join();

    // 保存された版を取り出す。stop() 前の running で保存された状況を模すため status を戻す
    const saved = await sessionsStorage.get(id);
    ok(saved, "保存されていない");
    eq(saved.turns.length, 3, "確定した3ターンだけが保存されるべき（4ターン目は未確定）");
    saved.status = "running";

    // 新しいエンジン（＝リロード後）で復元する
    resetState();
    const seen = [];
    on("turn:committed", (t) => seen.push(t.round + ":" + t.agentId));
    let n2 = 0;
    const engine2 = createEngine({
      callProvider: async (agent, ctx, opts) => {
        opts.budget.check(); opts.budget.consume(); n2++;
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 };
      },
      storage: sessionsStorage, clock
    });
    const restored = await engine2.restore(saved);
    eq(state.status, "paused", "復元直後は paused であるべき");
    eq(seen.length, 3, "保存済みの3ターンが UI に再生されるべき");
    eq(restored.cursor.round, 2, "カーソルは未確定ターンの位置のまま");
    eq(restored.cursor.index, 0);

    const r = await engine2.resume();
    eq(r.status, "done");
    eq(r.session.turns.length, 6, "続きの3ターンが足されて6になるべき");
    eq(n2, 3, "再開後に叩く回数は残りの3回だけ");
    eq(r.session.roundOrder[1].join(), r1Before, "復元前に確定した R1 の発言順が変わった");
  });

  await atest("S-8 完走したセッションは未完了として拾われない（D-029）", async () => {
    await sessionsStorage.clearAll();
    resetState();
    const engine = createEngine({
      callProvider: async (a, c, opts) => { opts.budget.check(); opts.budget.consume();
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 }; },
      storage: sessionsStorage, clock: createFakeClock()
    });
    await engine.start({ topic: "完走", config: { ...DEFAULTS, agents: agents(2), rounds: 1, enableSummaryRound: false }, seed: 1 });
    // finish() が保存していなければ、最後の保存は status:"running" のままになる
    const saved = await sessionsStorage.get(state.session.id);
    eq(saved.status, "done", "終了状態が保存されていない");
    eq(await sessionsStorage.findUnfinished(), null, "完走したのに再開候補として拾われる");
  });

  await atest("S-9 復元後に再開しても発言が二重にならない（D-029）", async () => {
    await sessionsStorage.clearAll();
    resetState();
    const engine = createEngine({
      callProvider: async (a, c, opts) => { opts.budget.check(); opts.budget.consume();
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 }; },
      storage: sessionsStorage, clock: createFakeClock()
    });
    await engine.start({ topic: "二重", config: { ...DEFAULTS, agents: agents(2), rounds: 2, enableSummaryRound: false, order: "fixed" }, seed: 1 });
    const id = state.session.id;
    // 3ターン目を確定した直後の保存を取り出し、running に戻して復元する
    const full = await sessionsStorage.get(id);
    const snap = JSON.parse(JSON.stringify(full));
    snap.turns = snap.turns.slice(0, 3);
    snap.cursor = { round: 2, index: 1 };
    snap.status = "running";
    snap.roundOrder = { 1: full.roundOrder[1], 2: full.roundOrder[2] };
    resetState();
    const engine2 = createEngine({
      callProvider: async (a, c, opts) => { opts.budget.check(); opts.budget.consume();
        return { text: okText(), usage: {}, finishReason: "stop", elapsedMs: 1 }; },
      storage: sessionsStorage, clock: createFakeClock()
    });
    await engine2.restore(snap);
    const r = await engine2.resume();
    eq(r.session.turns.length, 4, "発言が二重になっている、または足りない");
    const keys = r.session.turns.map((t) => t.round + ":" + t.index);
    eq(new Set(keys).size, 4, "同じ位置の発言が重複している: " + keys.join(","));
  });

  await atest("S-6 終了済みセッションの復元は閲覧のみ（paused にしない）", async () => {
    resetState();
    const engine = createEngine({
      callProvider: async () => ({ text: okText(), usage: {} }),
      storage: sessionsStorage, clock: createFakeClock()
    });
    await engine.restore(blank("s_done", {
      config: { ...DEFAULTS, agents: agents(2), rounds: 1, enableSummaryRound: false },
      roundOrder: { 1: ["a0", "a1"] },
      turns: [{ round: 1, index: 0, agentId: "a0", role: "propose", text: "x", chars: 1 }],
      cursor: { round: 2, index: 0 }, requestCount: 1
    }));
    eq(state.status, "done");
  });

  await atest("S-7 実行中は復元できない", async () => {
    resetState();
    state.status = "running";
    const engine = createEngine({
      callProvider: async () => ({ text: "x", usage: {} }),
      storage: sessionsStorage, clock: createFakeClock()
    });
    eq(await engine.restore(blank("s_x")), null);
    resetState();
  });

  group("engine.js セッションIDの一意性（D-060）");

  await atest("S-11 同じ時刻に作ったセッションでもIDが衝突しない", async () => {
    // 秒までしか見ていなかった頃は、開始→停止→開始を1秒以内に行うと同じIDになり、
    // IndexedDB（keyPath: id）で先のセッションが黙って上書きされて消えていた。
    const { createSession } = await import("../js/engine.js");
    const cfg = { ...DEFAULTS, agents: agents(2) };
    const now = 1788000000000;
    const ids = [
      createSession({ topic: "1", config: cfg, seed: 1, now }).id,
      createSession({ topic: "2", config: cfg, seed: 2, now }).id,           // 完全に同時刻
      createSession({ topic: "3", config: cfg, seed: 3, now }).id,
      createSession({ topic: "4", config: cfg, seed: 4, now: now + 400 }).id // 同じ秒の中
    ];
    eq(new Set(ids).size, 4, "IDが衝突している: " + ids.join(" / "));
    ok(ids.every((id) => /^s_\d{8}_\d{6}_\d{3}(-\d+)?$/.test(id)), "ID形式が崩れた: " + ids.join(" / "));
  });

  await atest("S-12 同時刻の2セッションを保存しても両方残る", async () => {
    await sessionsStorage.clearAll();
    const { createSession } = await import("../js/engine.js");
    const cfg = { ...DEFAULTS, agents: agents(2) };
    const now = 1788000001000;
    const a = createSession({ topic: "議論A", config: cfg, seed: 1, now });
    const b = createSession({ topic: "議論B", config: cfg, seed: 2, now });
    await sessionsStorage.save(a);
    await sessionsStorage.save(b);
    const list = await sessionsStorage.list();
    eq(list.length, 2, "先に保存したセッションが上書きで消えている");
    ok(list.some((s) => s.topic === "議論A") && list.some((s) => s.topic === "議論B"));
    await sessionsStorage.clearAll();
  });

  group("ui/sessions.js ストレージ障害時の挙動（D-057）");

  await atest("S-10 IndexedDB が使えなくても、履歴パネルは閉じられる形で開く", async () => {
    // プライベートウィンドウやストレージ制限で list() が投げる状況。
    // 以前はパネルだけ開いて中身も閉じるボタンも無い状態になっていた
    // （クリックハンドラが async なので例外の通知も出ない）。
    const { mountSessions } = await import("../js/ui/sessions.js");
    const { el } = await import("../js/ui/dom.js");
    const root = el("div"), btn = el("button");
    const failing = {
      list: async () => { throw new Error("IndexedDB is disabled"); },
      get: async () => null, save: async () => {}, remove: async () => {}
    };
    const ui = mountSessions(root, btn, { storage: failing, engine: { restore: async () => {} } });
    await ui.open();

    ok(root.querySelector(".modal-head"), "閉じるボタンを含むヘッダが無い");
    const closeBtn = [...root.querySelectorAll("button")].find((b) => b.textContent === "閉じる");
    ok(closeBtn, "「閉じる」ボタンが無い");
    ok(root.textContent.includes("読み込めませんでした"), "失敗が利用者に伝わっていない");
    ok(root.textContent.includes("IndexedDB is disabled"), "原因が表示されていない");

    closeBtn.click();
    eq(root.hidden, true, "閉じられない");
  });

  await sessionsStorage.clearAll();
}
