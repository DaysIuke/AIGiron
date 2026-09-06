// state.js — アプリ全体の単一ストア。購読による通知のみを行う。

import { maskKey } from "./errors.js";

export const state = { status: "idle", session: null, ui: {} };

const subs = new Map();

export function on(key, handler) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(handler);
  // 購読解除。resetState() で subs が空になった後に呼ばれても落ちないようにする
  //   （素の subs.get(key).delete(...) だと undefined を触って投げる・D-059）
  return () => { subs.get(key)?.delete(handler); };
}

export function emit(key, payload) {
  const set = subs.get(key);
  if (!set) return;
  // 反復中に購読が増減しても壊れないようコピーしてから回す。
  // 購読者の例外はここで止める（1つの購読者の失敗で他の描画を巻き添えにしない）。
  for (const h of [...set]) {
    try { h(payload); } catch (e) { console.error("購読者で例外:", key, maskKey(String(e?.message ?? e))); }
  }
}

export function setStatus(next) {
  if (state.status === next) return;
  state.status = next;
  emit("engine:status", next);
}

// テスト用。購読とセッションを初期化する。
export function resetState() {
  subs.clear();
  state.status = "idle";
  state.session = null;
  state.ui = {};
}
