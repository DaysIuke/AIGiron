// tests/usage.test.js — 日次リクエスト数の UTC リセット。

import { group, test, eq } from "./runner.js";
import { createUsage } from "../js/usage.js";

function memStore() {
  let data = null;
  return { load: () => data, save: (u) => { data = JSON.parse(JSON.stringify(u)); } };
}

export function run() {
  group("usage.js 日次カウント");

  test("U-1 加算はプロバイダ別に数えられる", () => {
    let t = Date.UTC(2026, 7, 24, 10, 0);
    const u = createUsage({ now: () => t, storage: memStore() });
    u.increment("groq");
    u.increment("groq");
    u.increment("gemini");
    eq(u.snapshot().counts, { groq: 2, gemini: 1 });
  });

  test("U-2 UTC の日付が変わるとリセットされる（RB-M8）", () => {
    let t = Date.UTC(2026, 7, 24, 23, 59);
    const u = createUsage({ now: () => t, storage: memStore() });
    u.increment("groq");
    eq(u.snapshot().counts.groq, 1);
    t = Date.UTC(2026, 7, 25, 0, 1);   // 2分後だが UTC 日付が変わる
    eq(u.increment("groq"), 1, "日付が変わったのに引き継いでいる");
    eq(u.snapshot().utcDate, "2026-08-25");
  });

  test("U-3 snapshot は日付が変わっていたら空を返す（加算せずに見るだけ）", () => {
    let t = Date.UTC(2026, 7, 24, 10, 0);
    const u = createUsage({ now: () => t, storage: memStore() });
    u.increment("groq");
    t = Date.UTC(2026, 7, 25, 10, 0);
    eq(u.snapshot().counts, {});
  });

  // D-063: 書けない環境では毎回 load() が空を返し、加算しても常に0のままだった。
  test("U-5 localStorage が書けなくてもカウントが積み上がる", () => {
    const KEY = "aigiron_usage_v1";
    localStorage.removeItem(KEY);
    const origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error("QuotaExceededError"); };
    try {
      const u = createUsage({ now: () => Date.parse("2026-09-02T10:00:00Z") });
      u.increment("groq");
      u.increment("groq");
      u.increment("gemini");
      const s = u.snapshot();
      eq(s.counts.groq, 2, "書けない環境で加算が失われている");
      eq(s.counts.gemini, 1);
    } finally {
      Storage.prototype.setItem = origSet;
      localStorage.removeItem(KEY);
    }
  });

  test("U-4 JST の日付変わり（UTC 15時）では切り替わらないことを明示", () => {
    // 日本時間の 0 時 = UTC 15 時。UTC 基準なので日本の日付変わりでは切り替わらない。
    let t = Date.UTC(2026, 7, 24, 14, 59);   // JST 23:59
    const u = createUsage({ now: () => t, storage: memStore() });
    u.increment("groq");
    t = Date.UTC(2026, 7, 24, 15, 1);        // JST 翌 0:01 だが UTC は同日
    eq(u.increment("groq"), 2, "UTC 基準なら継続するべき");
  });
}
