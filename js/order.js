// order.js — 発言順の決定（純関数）。

import { mulberry32, shuffle } from "./rng.js";

// B003: 位置バイアス対策で発言順をランダム化する
// D-031: leadId を渡すと、そのAIを先頭に固定し、残りだけをランダム化する。
//   持ち回り型では提案役が最初に喋らないと、批判役が「存在しない提案」を捏造して批判する。
export function computeOrder(agents, round, mode, seed, { leadId = null } = {}) {
  const alive = agents.filter((a) => a.status !== "dropped");
  let order = mode === "fixed" ? alive : shuffle(alive, mulberry32(seed + round * 7919));
  if (leadId) {
    const lead = order.find((a) => a.id === leadId);
    if (lead) order = [lead, ...order.filter((a) => a.id !== leadId)];
  }
  return order;
}
