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
  // D-089: **総括の判定を最初に行う**。形式の分岐が先にあったため、
  //   対立型・全員提案・自由討論では総括ラウンドに来ても通常の役割が返り、
  //   「①最終見解 ②相手の主張のうち認める点」という総括の指示が出ていなかった。
  //   設定で「総括ラウンド: あり」にしても、その1周は普通の発言が増えるだけだった。
  //   既存テストは R-5 が rotation だけ・R-6 が R1 だけを見ており、隙間に落ちていた。
  //   D-088 の進行役を入れてから、【進行状況】「総括ラウンドです。新しい論点は出さず…」と
  //   【今回あなたがすること】「自分の立場から論じてください」が同時に出て矛盾が表面化した。
  if (round > config.rounds) return "summary";
  if (config.format === "free") return "free";
  if (config.format === "allpropose") return "both";
  if (config.format === "debate") return "stance";

  // rotation: 提案役は毎ラウンド1体。生存メンバーの roleIndex 昇順で回す（BD §4.5 / D-033）。
  return proposerFor(round, config) === roleIndex ? "propose" : "critique";
}
