// context.js — コンテキスト構築（純関数）。
// session.summaries は読むだけ。書き込みは engine が行う（BD §4.9）。

import { ROLE_LABELS, HUMAN_ID } from "./config.js";
import { systemPrompt, roundInstruction, progressNote } from "./prompts.js";

// A033: 疎な通信でトークンを削減する
// A005: 通信トポロジの4形態
function visibleTurns(session, agent, turns, topology) {
  if (topology === "all") return turns;
  if (topology === "previous") return turns.slice(-1);
  if (topology === "adjacent") {
    // 環状の隣接。端の参加AIも両隣2体が見える（BD §4.7）
    const byId = new Map(session.config.agents.map((a) => [a.id, a]));
    const n = session.config.agents.length;
    return turns.filter((t) => {
      const other = byId.get(t.agentId);
      if (!other) return false;
      const d = Math.abs(other.roleIndex - agent.roleIndex);
      return Math.min(d, n - d) <= 1;
    });
  }
  if (topology === "judgeOnly") return turns.slice(-1);
  return turns;
}

function label(session, agentId) {
  if (agentId === HUMAN_ID) return "司会";
  const a = session.config.agents.find((x) => x.id === agentId);
  return a ? a.name : agentId;
}

// AIの発言に「【司会からの指示・質問】」と書かれても、本物の司会ブロックと紛れないようにする。
// 本物は buildContext が HUMAN_ID の発言からだけ組み立てる（B071 の延長）。
const MOD_HEAD = "【司会からの指示・質問】";
function neutralize(text) {
  return String(text ?? "").split(MOD_HEAD).join("〔司会からの指示・質問〕");
}

function renderTurn(session, t) {
  const role = ROLE_LABELS[t.role] ?? t.role;
  return `R${t.round} ${label(session, t.agentId)}(${role}): 「${neutralize(t.text)}」`;
}

// あるラウンドの発言を素のテキストにする。要約の入力に使う。
export function renderRoundPlain(session, round) {
  return session.turns
    .filter((t) => t.round === round)
    .map((t) => renderTurn(session, t))
    .join("\n");
}

export function truncate(text, n) {
  const s = String(text ?? "");
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export function buildContext(session, agent, round, role) {
  const cfg = session.config;
  // D-074: 413（送りすぎ）で縮めた段階。1 = 全文は直近1ラウンドだけ、2 = さらに直前の発言だけ。
  //   設定は変えず、セッションの残りにだけ効かせる。
  const shrink = session.contextShrink ?? 0;
  const contextRounds = shrink >= 1 ? 1 : cfg.contextRounds;
  const topology = shrink >= 2 ? "previous" : cfg.topology;
  const recentFrom = Math.max(1, round - contextRounds);

  const hasSpoken = session.turns.some((t) => t.agentId === agent.id);
  const system = systemPrompt({
    name: agent.name,
    roleInstruction: roundInstruction(role),
    stance: agent.stance,
    maxChars: cfg.maxChars,
    format: cfg.format,
    hasSpoken,
    persona: agent.persona || "",
    solo: Boolean(agent.solo)
  });

  const parts = [`【議題】${session.topic}`];

  // FR-12-04（D-077）: 前の議論から引き継いだ前提。議題の直後に置く。
  //   これが無いと、「残った問い」から始めた議論が前の結論を知らずに一から始まる。
  const pr = session.premise;
  if (pr && (pr.answer || pr.fromTopic)) {
    const cap = shrink >= 2 ? 120 : shrink >= 1 ? 200 : 400;
    const lines = [];
    if (pr.fromTopic) lines.push(`前の議題: ${truncate(pr.fromTopic, 120)}`);
    if (pr.answer) lines.push(`前の結論: ${truncate(pr.answer, cap)}`);
    lines.push("今回の議題は、その議論で残った問いです。前の結論を踏まえたうえで論じてください。");
    parts.push("【前の議論からの引き継ぎ】\n" + lines.join("\n"));
  }

  // 直近より前のラウンドは要約で渡す
  const summarized = [];
  for (let r = 1; r < recentFrom; r++) {
    // 要約が無いラウンド（縮小で範囲が動いた直後など）は、その場で切り詰めて渡す。黙って落とさない。
    const sm = session.summaries[r] ?? truncate(renderRoundPlain(session, r), 400);
    if (sm) summarized.push(`R${r}: ${sm}`);
  }
  if (summarized.length) {
    parts.push("【これまでの議論の要約】\n" + summarized.join("\n"));
  }

  // 直近 contextRounds ラウンドは全文。自分の発言はここから外す。
  // FR-05-07: 司会（人間）の差し込みはトポロジで絞らず、直近の範囲にあれば必ず渡す。
  // FR-03-12（D-088）: **総括ラウンドでは、同じラウンドの他者の総括を渡さない**。
  //   渡すと2人目以降が1人目のまとめを読んでから書くことになり、追従（B012）と
  //   位置バイアス（B003）がそのまま結論に乗る。さらに悪いことに、AIGiron は
  //   合意度（FR-09-03）と意見変更回数（FR-09-04）を**その総括を含む議論から測る**ので、
  //   見かけの合意が水増しされる。**測定対象を測定手順が汚している**状態だった。
  //   全員に同じ材料（最後の通常ラウンドまで）を渡して独立にまとめさせる。
  //   参照実装 takano32/ChatGPT-vs-Gemini も同じ理由で相手の「最後の通常発言」を渡している。
  const isSummaryRound = round > cfg.rounds;
  const recentAll = session.turns.filter(
    (t) => t.round >= recentFrom && t.round <= round && t.agentId !== agent.id &&
      !(isSummaryRound && t.round === round && t.agentId !== HUMAN_ID)
  );
  const notes = recentAll.filter((t) => t.agentId === HUMAN_ID);
  const recent = recentAll.filter((t) => t.agentId !== HUMAN_ID);
  const shown = visibleTurns(session, agent, recent, topology);
  if (shown.length) {
    parts.push("【直近の発言】\n" + shown.map((t) => renderTurn(session, t)).join("\n"));
  }

  // 自分の発言は常に渡す（自分の立場を見失わせない）。ただしラウンド数に比例して増えるため、
  // D-075: 縮小中は**直近の数件だけ全文**にして、それより前は切り詰める。
  //   D-074 で「他者の発言」だけを縮めたが、自分の発言は手つかずだった。ラウンドが進むと
  //   ここが最大の項になり（3ラウンドなら 3×maxChars）、縮めても 413 を抜けられない。
  const own = session.turns.filter((t) => t.agentId === agent.id);
  if (own.length) {
    const keepFull = shrink >= 2 ? 1 : shrink >= 1 ? 2 : own.length;
    const from = Math.max(0, own.length - keepFull);
    parts.push(
      "【あなたのこれまでの発言】\n" +
      own.map((t, i) => `R${t.round}: 「${i < from ? truncate(t.text, 100) : t.text}」`).join("\n")
    );
  }

  // FR-05-07（D-070）: 司会からの差し込み。末尾近くに置いて必ず応えさせる（C017）。
  if (notes.length) {
    parts.push(MOD_HEAD + "\n" +
      notes.map((t) => `R${t.round}: 「${neutralize(t.text)}」`).join("\n") +
      "\n司会は議論の運営者です。上の指示・質問には次の発言の中で必ず応えてください。");
  }

  // FR-03-11（D-088）: 進行役。指示の直前に置いて、残りと段階を意識させる（C017 の直前）。
  parts.push(progressNote(round, cfg.rounds, Boolean(cfg.enableSummaryRound)));

  // C017: 重要な指示は末尾に置く
  parts.push("【今回あなたがすること】\n" + roundInstruction(role));

  return { system, user: parts.join("\n\n") };
}
