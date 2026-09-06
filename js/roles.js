// roles.js — 役割割り当て（純関数）。

// そのラウンドの提案役の roleIndex を返す（rotation 用）。
// FR-06-08: 離脱者を除いた生存メンバーで組み直す。全員生存なら (round-1) % n と同じ。
// 生存が変わらない限り、連続するラウンドで同じ roleIndex が提案役になることはない。
export function proposerFor(round, config) {
  const alive = config.agents
    .filter((a) => a.status !== "dropped")
    .map((a) => a.roleIndex)
    .sort((x, y) => x - y);
  if (!alive.length) return null;
  return alive[(round - 1) % alive.length];
}

export function roleOf(roleIndex, round, config) {
  if (config.format === "free") return "free";
  if (config.format === "allpropose") return "both";
  if (config.format === "debate") return "stance";
  if (round > config.rounds) return "summary";   // 総括ラウンド

  // rotation: 提案役は毎ラウンド1体。生存メンバーの roleIndex 昇順で回す（BD §4.5 / D-033）。
  return proposerFor(round, config) === roleIndex ? "propose" : "critique";
}
