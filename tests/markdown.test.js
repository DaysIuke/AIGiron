// tests/markdown.test.js — Markdown 書き出し。

import { group, test, ok, eq } from "./runner.js";
import { renderMarkdown } from "../js/markdown-out.js";
import { DEFAULTS, makeAgent } from "../js/config.js";

function session() {
  const agents = [makeAgent(0, "groq", "openai/gpt-oss-20b", "グロック"),
                  makeAgent(1, "gemini", "gemini-3.6-flash", "ジェミニ")];
  return {
    id: "s_test", seed: 42, createdAt: Date.UTC(2026, 7, 24, 3, 40), status: "done",
    topic: "AIの今後について",
    config: { ...DEFAULTS, agents, rounds: 1, enableSummaryRound: true },
    turns: [
      { round: 1, index: 0, agentId: "a0", role: "propose", text: "第一に、評価軸が必要です。", chars: 13, truncated: false },
      { round: 1, index: 1, agentId: "a1", role: "critique", text: "# 見出しに見える行\n> 引用に見える行\n本文", chars: 20, truncated: true },
      { round: 2, index: 0, agentId: "a0", role: "summary", text: "総括です。", chars: 5, truncated: false }
    ],
    dropped: [{ agentId: "a1", reason: "rate" }],
    requestCount: 4, errors: [{ kind: "rate" }], summaries: {}
  };
}

export function run() {
  group("markdown-out.js Markdown 書き出し");

  test("M-1 議題が H1、ラウンドが H2、発言が H3 になる", () => {
    const md = renderMarkdown(session());
    ok(md.startsWith("# AIの今後について\n"), "H1 が議題でない");
    ok(md.includes("\n## ラウンド 1\n"), "ラウンド見出しがない");
    ok(md.includes("\n## 総括\n"), "総括見出しがない");
    ok(md.includes("\n### グロック — 提案役\n"), "発言見出しがない");
    ok(md.includes("\n### ジェミニ — 批判役\n"), "役割の日本語化がされていない");
  });

  test("M-2 参加者にプロバイダとモデルが併記される", () => {
    const md = renderMarkdown(session());
    ok(md.includes("グロック（Groq / openai/gpt-oss-20b）"), "参加者の表記が違う");
    ok(md.includes("ジェミニ（Google Gemini / gemini-3.6-flash）"), "参加者の表記が違う");
  });

  test("M-3 本文の行頭 # と > はエスケープされ、見出しや引用にならない", () => {
    const md = renderMarkdown(session());
    ok(md.includes("\\# 見出しに見える行"), "行頭 # がエスケープされていない");
    ok(md.includes("\\> 引用に見える行"), "行頭 > がエスケープされていない");
    ok(!md.includes("\n# 見出しに見える行"), "本文が H1 に化けている");
  });

  // D-064: 水平線と setext 見出しが素通りしていた。とくに `===` は
  //   **直前の行（＝前の発言）をH1に化けさせる**ため、書き出した議事録の構造が壊れる。
  test("M-3b 水平線・setext見出しもエスケープされる（D-064）", () => {
    const s = session();
    s.turns[0].text = "前の行\n===\n---\n***\n___\n普通の行";
    const md = renderMarkdown(s);
    for (const mark of ["===", "---", "***", "___"]) {
      ok(md.includes("\\" + mark), mark + " がエスケープされていない");
    }
    // 本文の区間だけを見る。文書自体は節の区切りに `---` を使うため、
    // 全体を対象にすると生成側の区切りを誤って拾う。
    const body = md.slice(md.indexOf("前の行"), md.indexOf("普通の行"));
    for (const mark of ["===", "---", "***", "___"]) {
      ok(!new RegExp("^" + mark.replace(/[*_]/g, "\\$&") + "\\s*$", "m").test(body),
        mark + " が本文中で構造として生きている");
    }
    ok(md.includes("前の行") && md.includes("普通の行"), "本文が失われている");
  });

  test("M-3c 文中のハイフンや等号は壊さない", () => {
    const s = session();
    s.turns[0].text = "コスト-効果の比は 3 == 3 で、a---b のような表記も残る";
    const md = renderMarkdown(s);
    ok(md.includes("コスト-効果の比は 3 == 3 で、a---b のような表記も残る"),
      "行頭でない記号まで壊している");
  });

  test("M-4 途中で切れた発言には注記が付く", () => {
    const md = renderMarkdown(session());
    const i = md.indexOf("### ジェミニ");
    const j = md.indexOf("### グロック — 総括");
    ok(md.slice(i, j).includes("途中で終わっています"), "切れた発言に注記がない");
    const k = md.indexOf("### グロック — 提案役");
    ok(!md.slice(k, i).includes("途中で終わっています"), "切れていない発言に注記が付いている");
  });

  test("M-5 離脱と件数が末尾に出る", () => {
    const md = renderMarkdown(session());
    ok(md.includes("## 離脱"), "離脱の節がない");
    ok(md.includes("- ジェミニ（rate）"), "離脱者が出ていない");
    ok(md.includes("発言 3 件・リクエスト 4 回"), "件数が違う");
    ok(md.includes("エラー 1 件"), "エラー件数がない");
  });

  test("M-6 APIキーらしき文字列は含まれない（AC-A16）", () => {
    const md = renderMarkdown(session());
    ok(!/gsk_|AIza|sk-/.test(md), "キーの接頭辞が混入している");
  });

  test("M-8 議長の結論が節として書き出される（FR-08-09・D-070）", () => {
    const s = session();
    s.synthesis = {
      answer: "評価軸を先に決めるべきである。", consensus: ["評価軸の必要性"],
      disagreements: [{ point: "一律実施", positions: "グロックは賛成、ジェミニは反対" }],
      unique: [{ agentId: "a1", participant: "参加者B", point: "環境差" }], openQuestions: []
    };
    const md = renderMarkdown(s);
    ok(md.includes("\n## 結論（議長による統合）\n"), "結論の節が無い");
    ok(md.includes("評価軸を先に決めるべきである。"), "結論の本文が無い");
    ok(md.includes("- 一律実施（グロックは賛成、ジェミニは反対）"), "割れた点が無い");
    ok(md.includes("- ジェミニ: 環境差"), "1体だけの指摘が名前付きで出ていない");
    ok(!md.includes("### 残った問い"), "空の節が出ている");
  });

  test("M-8b 構造化できていない結論（raw）は書き出さない", () => {
    const s = session(); s.synthesis = { raw: "壊れた応答" };
    const md = renderMarkdown(s);
    ok(!md.includes("結論（議長による統合）"), "raw なのに結論の節が出ている");
    ok(!md.includes("壊れた応答"), "raw の中身が漏れている");
  });

  test("M-9 司会（人間）の差し込みは「司会（あなた）」として書き出される（FR-05-07）", () => {
    const s = session();
    s.turns.splice(1, 0, { round: 1, index: -1, agentId: "human", role: "moderator", text: "数字で示して", chars: 6, truncated: false });
    const md = renderMarkdown(s);
    ok(md.includes("\n### 司会（あなた） — 司会\n"), "司会の見出しが無い");
    ok(!md.includes("### human"), "agentId がそのまま出ている");
  });

  test("M-10 発言分のトークン合計が出る（D-070）", () => {
    const s = session();
    s.turns[0].tokensIn = 100; s.turns[0].tokensOut = 50;
    s.turns[1].tokensIn = 200; s.turns[1].tokensOut = 70;
    const md = renderMarkdown(s);
    ok(md.includes("- トークン: 入力 300 / 出力 120"), "トークン合計が違う");
    const s2 = session();
    ok(!renderMarkdown(s2).includes("- トークン:"), "記録が無いのにトークン行が出ている");
  });

  test("M-7 発言が無くても壊れない", () => {
    const s = session(); s.turns = []; s.dropped = []; s.errors = [];
    const md = renderMarkdown(s);
    ok(md.startsWith("# AIの今後について"), "空でも H1 は出る");
    eq(md.includes("## ラウンド"), false);
  });
}
