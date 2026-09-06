// tests/state.test.js — 単一ストアと購読（D-059）。
// 全モジュールがこの上に載るため、境界の壊れ方をここで固定する。

import { group, test, eq, ok } from "./runner.js";
import { state, on, emit, setStatus, resetState } from "../js/state.js";

export function run() {
  group("state.js 単一ストアと購読");

  test("SB-1 購読した順に呼ばれ、payload がそのまま届く", () => {
    resetState();
    const seen = [];
    on("x", (p) => seen.push("a:" + p));
    on("x", (p) => seen.push("b:" + p));
    emit("x", 1);
    eq(seen, ["a:1", "b:1"]);
  });

  test("SB-2 購読者が無いキーへの emit は何も起きない", () => {
    resetState();
    emit("誰も見ていない", 1);   // 例外にならなければよい
    ok(true);
  });

  test("SB-3 on の戻り値で購読を解除できる", () => {
    resetState();
    let n = 0;
    const off = on("x", () => { n++; });
    emit("x");
    off();
    emit("x");
    eq(n, 1, "解除後も呼ばれている");
  });

  // resetState() で subs が空になった後に解除関数を呼ぶと、
  // 素の実装では undefined を触って落ちていた（D-059）。
  test("SB-4 resetState の後に解除関数を呼んでも落ちない", () => {
    resetState();
    const off = on("x", () => {});
    resetState();
    off();          // ここで投げないこと
    ok(true);
  });

  test("SB-5 購読者が投げても他の購読者に波及しない", () => {
    resetState();
    const seen = [];
    on("x", () => { throw new Error("わざと失敗"); });
    on("x", () => seen.push("後続が呼ばれた"));
    emit("x");
    eq(seen, ["後続が呼ばれた"], "1つの購読者の失敗が他を巻き添えにしている");
  });

  test("SB-6 通知の最中に購読を足しても反復が壊れない", () => {
    resetState();
    let n = 0;
    on("x", () => { n++; on("x", () => { n += 10; }); });
    emit("x");            // この回では増えた分は呼ばれない
    eq(n, 1);
    emit("x");            // 次の回から呼ばれる
    ok(n > 1, "後から足した購読者が呼ばれていない");
  });

  test("SB-7 setStatus は変化したときだけ engine:status を出す", () => {
    resetState();
    const seen = [];
    on("engine:status", (s) => seen.push(s));
    setStatus("running");
    setStatus("running");   // 同じ値なので出さない
    setStatus("paused");
    eq(seen, ["running", "paused"]);
    eq(state.status, "paused");
  });

  test("SB-8 resetState は購読・状態・セッションを初期化する", () => {
    resetState();
    let n = 0;
    on("x", () => { n++; });
    state.session = { id: "s" };
    setStatus("running");

    resetState();
    emit("x");
    eq(n, 0, "解除されていない購読が残っている");
    eq(state.status, "idle");
    eq(state.session, null);
  });
}
