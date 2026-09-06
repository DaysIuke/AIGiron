// usage.js — プロバイダ別の日次リクエスト数。UTC 日付で区切る（BD §8.4）。
// 正確な残枠ではなく目安。プロバイダ側の課金・制限の実態は各コンソールで見る。

import { emit } from "./state.js";

const KEY = "aigiron_usage_v1";

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// now を注入できるようにして、日付の切り替わりをテスト可能にする
export function createUsage({ now = () => Date.now(), storage = null } = {}) {
  // localStorage が書けない環境（プライベートウィンドウ・容量超過）では、
  // 毎回 load() が空を返すため加算しても常に0のままだった（D-063）。
  // storage/settings.js が鍵に対して memoryKeys を持つのと同じ考え方で、
  // メモリ側にも最後の値を持ち、書けないときはそれを使う。
  let memory = null;
  const store = storage ?? {
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === "object") return raw;
      } catch { /* 読めなければメモリへ落ちる */ }
      return memory;
    },
    save(u) {
      memory = u;
      try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* 保存できなくても続行 */ }
    }
  };

  function load() {
    const u = store.load();
    return u && typeof u === "object" ? u : { utcDate: utcDate(now()), counts: {} };
  }

  return {
    // 加算のたびに UTC 日付を比較する（RB-M8）。日付が変わっていたらリセット。
    increment(provider) {
      const today = utcDate(now());
      const u = load();
      if (u.utcDate !== today) { u.utcDate = today; u.counts = {}; }
      u.counts[provider] = (u.counts[provider] ?? 0) + 1;
      store.save(u);
      emit("usage:daily", { utcDate: u.utcDate, counts: { ...u.counts } });
      return u.counts[provider];
    },

    snapshot() {
      const today = utcDate(now());
      const u = load();
      return u.utcDate === today ? { utcDate: today, counts: { ...u.counts } }
                                 : { utcDate: today, counts: {} };
    }
  };
}
