// markdown-out.js — セッションを Markdown に書き出す。解釈はしない（書くだけ）。
// AI応答はそのまま本文に置く。HTML に戻すのは利用者側のツールの責任。

import { ROLE_LABELS, FORMAT_LABELS, PROVIDERS, HUMAN_ID } from "./config.js";

function pad(n) { return String(n).padStart(2, "0"); }

function stamp(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
         " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function agentLabel(s, id) {
  const a = s.config.agents.find((x) => x.id === id);
  if (!a) return id;
  const prov = PROVIDERS[a.provider]?.label ?? a.provider;
  return a.name + "（" + prov + " / " + a.model + "）";
}

function agentName(s, id) {
  if (id === HUMAN_ID) return "司会（あなた）";
  return s.config.agents.find((x) => x.id === id)?.name ?? id;
}

// 見出し記法と衝突しないよう、構造を作る行頭記号をエスケープする。本文の改変はこれだけ。
// D-064: 当初は # と > だけだったが、次の2つが素通りしていた。
//   - `---` / `***` / `___`: 水平線になり、書き出した議事録の構造が勝手に切れる
//   - `===` / `---`: setext 見出し。**直前の行（＝前の発言）をH1/H2に化けさせる**ため影響が大きい
//   いずれも「AIの発言が書き出し文書の構造を乗っ取る」ので塞ぐ。
const STRUCTURAL_LINE = /^\s*([#>]|-{3,}\s*$|={3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;

function safeBody(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => (STRUCTURAL_LINE.test(line) ? "\\" + line.trimStart() : line))
    .join("\n");
}

export function renderMarkdown(s) {
  const cfg = s.config;
  const out = [];

  out.push("# " + s.topic);
  out.push("");
  out.push("- 日時: " + stamp(s.createdAt));
  out.push("- 形式: " + (FORMAT_LABELS[cfg.format] ?? cfg.format) +
           " / " + cfg.rounds + " ラウンド" + (cfg.enableSummaryRound ? " ＋ 総括" : ""));
  out.push("- 参加: " + cfg.agents.map((a) => agentLabel(s, a.id)).join("、"));
  out.push("- 状態: " + s.status + "（発言 " + s.turns.length + " 件・リクエスト " + s.requestCount + " 回）");
  {
    // D-070: 発言分のトークン合計。審判の呼び出しは turns に無いので含まない。
    let tin = 0, tout = 0, any = false;
    for (const t of s.turns) {
      if (Number.isFinite(t.tokensIn)) { tin += t.tokensIn; any = true; }
      if (Number.isFinite(t.tokensOut)) { tout += t.tokensOut; any = true; }
    }
    if (any) out.push("- トークン: 入力 " + tin.toLocaleString() + " / 出力 " + tout.toLocaleString() + "（発言分の合計。審判は含まない）");
  }
  out.push("- シード: " + s.seed);
  out.push("");

  const rounds = [...new Set(s.turns.map((t) => t.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    out.push("## " + (r > cfg.rounds ? "総括" : "ラウンド " + r));
    out.push("");
    for (const t of s.turns.filter((x) => x.round === r)) {
      const role = ROLE_LABELS[t.role] ?? t.role;
      out.push("### " + agentName(s, t.agentId) + " — " + role);
      out.push("");
      out.push(safeBody(t.text));
      if (t.truncated) {
        out.push("");
        out.push("> 注: この発言は出力上限に達したため途中で終わっています。");
      }
      out.push("");
    }
  }

  // FR-08-09（D-070）: 議長による統合。構造化できていないもの（raw）は書かない。
  const syn = s.synthesis;
  if (syn && !syn.raw && typeof syn.answer === "string" && syn.answer) {
    out.push("## 結論（議長による統合）");
    out.push("");
    out.push(safeBody(syn.answer));
    out.push("");
    const list = (title, items, fmt) => {
      if (!Array.isArray(items) || !items.length) return;
      out.push("### " + title);
      out.push("");
      for (const x of items) out.push("- " + safeBody(fmt(x)).replace(/\n/g, " "));
      out.push("");
    };
    list("一致した点", syn.consensus, (x) => x);
    list("割れた点", syn.disagreements, (d) => d.point + (d.positions ? "（" + d.positions + "）" : ""));
    list("1体だけが指摘した点", syn.unique, (u) => agentName(s, u.agentId) + ": " + u.point);
    list("残った問い", syn.openQuestions, (x) => x);
  }

  if (s.dropped.length) {
    out.push("## 離脱");
    out.push("");
    for (const d of s.dropped) {
      out.push("- " + agentName(s, d.agentId) + "（" + d.reason + "）");
    }
    out.push("");
  }

  out.push("---");
  out.push("");
  out.push("AIGiron で生成。エラー " + s.errors.length + " 件。");
  out.push("");
  return out.join("\n");
}

// クリップボードへ。失敗したら false を返し、呼び出し側が案内を出す。
export async function copyMarkdown(s) {
  const md = renderMarkdown(s);
  try {
    await navigator.clipboard.writeText(md);
    return { ok: true, chars: md.length, md };
  } catch (e) {
    // フォーカスが無い・権限が無い等。呼び出し側が退避経路（テキストエリア表示）に回す
    return { ok: false, chars: md.length, md, message: String(e?.message ?? e) };
  }
}
