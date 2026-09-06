// main.js — 起動とDI配線。ここ以外でモジュールの結線を行わない。

import { realClock } from "./clock.js";
import { callProvider } from "./providers/index.js";
import { createEngine } from "./engine.js";
import { getKey, loadSettings, saveSettings } from "./storage/settings.js";
import { $, $$ } from "./ui/dom.js";
import { mountHeader } from "./ui/header.js";
import { mountInfobar } from "./ui/infobar.js";
import { mountControls } from "./ui/controls.js";
import { mountLog } from "./ui/log.js";
import { mountDebate } from "./ui/debate.js";
import { mountSettings } from "./ui/settings.js";
import { mountSessions } from "./ui/sessions.js";
import { mountExportFallback } from "./ui/export.js";
import { mountVerdict } from "./ui/verdict.js";
import { mountIssues } from "./ui/issues.js";
import { mountSynthesis } from "./ui/synthesis.js";
import { sessionsStorage } from "./storage/sessions.js";
import { on, emit, state } from "./state.js";
import { copyMarkdown } from "./markdown-out.js";
import { createUsage } from "./usage.js";
import { mountStatusbar } from "./ui/statusbar.js";
import { detectSummarizer, createSummarizer } from "./summarize.js";

const usage = createUsage({});

const engine = createEngine({
  callProvider,
  storage: sessionsStorage,            // Phase 1c: IndexedDB
  clock: realClock,
  summarizer: null,                    // 起動後に detectSummarizer の結果で差し替える
  getKey,
  usage
});

mountHeader($("#hdr-agents"), $("#hdr-round"));
const log = mountLog($("#log"), $("#log-toolbar"));
mountDebate($("#panel-debate"));
const settings = mountSettings($("#settings-root"), $("#btn-settings"));
mountInfobar($("#infobar"), (provider) => settings.open(provider));
mountControls(engine, (provider) => settings.open(provider));
mountSessions($("#sessions-root"), $("#btn-sessions"), { storage: sessionsStorage, engine });
mountStatusbar($("#statusbar"), usage);
mountVerdict($("#panel-verdict"));
mountIssues($("#panel-issues"));
mountSynthesis($("#panel-synthesis"));

// Chrome Summarizer（BD §9）。available のときだけ使う。
// downloadable のダウンロードは設定画面の明示操作（summarizer:download-requested）から。
(async () => {
  const { state: st } = await detectSummarizer();
  if (st === "available") {
    const s = await createSummarizer({});
    if (s) {
      engine.setSummarizer(s);
      emit("log:append", { level: "INFO", at: Date.now(),
        message: "要約に Chrome 内蔵 Summarizer を使います" });
    }
  }
})();

on("summarizer:download-requested", async () => {
  emit("log:append", { level: "INFO", at: Date.now(), message: "要約モデルをダウンロードしています…" });
  const s = await createSummarizer({ allowDownload: true });
  if (s) {
    engine.setSummarizer(s);
    emit("log:append", { level: "INFO", at: Date.now(), message: "要約モデルの準備ができました" });
  } else {
    emit("log:append", { level: "WARN", at: Date.now(),
      message: "要約モデルを用意できませんでした。切り詰めで代替します（動作には影響しません）" });
  }
});

// タブ切り替え。hidden の付け外しだけで行う（style 属性も CSSOM も使わない）。
for (const btn of $$("#tabs button[data-tab]")) {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    for (const b of $$("#tabs button[data-tab]")) b.dataset.active = String(b === btn);
    for (const name of ["debate", "synthesis", "issues", "verdict"]) {
      $("#panel-" + name).hidden = name !== target;
    }
  });
}

// AC-A12: 議論を Markdown でクリップボードへ。セッションがある間だけ押せる。
const btnCopy = $("#btn-copy-md");
const exportFallback = mountExportFallback($("#export-root"));
on("session:started", () => { btnCopy.disabled = false; });
btnCopy.addEventListener("click", async () => {
  if (!state.session) return;
  const r = await copyMarkdown(state.session);
  emit("log:append", {
    level: r.ok ? "INFO" : "WARN", at: Date.now(),
    message: r.ok
      ? "Markdown をコピーしました（" + r.chars.toLocaleString() + " 字）"
      : "クリップボードに書けないため、テキストで表示します（" + r.message + "）"
  });
  if (!r.ok) exportFallback.show(r.md, r.message);
});

// FR-10-06: 進行ログをテキストでコピー。表示中のフィルタに関わらず全件を出す。
$("#btn-copy-log").addEventListener("click", async () => {
  const text = log.getText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    emit("log:append", { level: "INFO", at: Date.now(), message: "ログをコピーしました" });
  } catch (e) {
    exportFallback.show(text, String(e?.message ?? e));
  }
});

// D-028: 提供終了モデルを後継に差し替えたら、保存済みの編成にも反映する。
//   セッション内だけ直しても、次回また提供終了モデルで始まって同じ失敗を繰り返す。
on("agent:model-swapped", ({ agentId, to }) => {
  const st = loadSettings();
  const list = st.agents ?? [];
  // レビュー: ソロ議論モード（D-043）は expandSolo() が展開時にペルソナへ "a0","a1","a2"...
  //   と id を振り直すが、保存済み設定には展開前の1体分しか無い（id は "a0" のみ）。
  //   2番目以降のペルソナでモデル自動切替が起きると agentId が一致せず保存されなかった。
  //   一致しない・かつ保存済みが1体だけ（＝ソロ元の構成）なら、同じプロバイダ・モデルを
  //   共有しているそのエントリを更新する。
  const a = list.find((x) => x.id === agentId) ?? (list.length === 1 ? list[0] : null);
  if (!a) return;
  a.model = to;
  saveSettings({ agents: list });
});

// FR-08-06: 人間の投票はセッションの一部として保存する（AIの判定とは別枠）。
on("votes:changed", () => {
  if (!state.session) return;
  Promise.resolve(sessionsStorage.save(state.session)).catch((e) => {
    emit("log:append", { level: "WARN", at: Date.now(),
      message: "投票の保存に失敗しました: " + String(e?.message ?? e) });
  });
});

// D-036: 審判のモデルが後継へ差し替わったら、保存済みの設定にも反映する。
on("judge:model-swapped", ({ to }) => {
  const st = loadSettings();
  const judge = { ...(st.debate?.judge ?? {}), model: to };
  saveSettings({ debate: { ...(st.debate ?? {}), judge } });
});

emit("log:append", {
  level: "INFO",
  at: Date.now(),
  message: "AIGiron を起動しました。設定からモックまたは Groq を選んでください。"
});

// BD §8.2: 中断したセッションがあれば再開を確認する。
//   「いいえ」なら stopped で保存し直し、次回また聞かれないようにする。
(async () => {
  let unfinished = null;
  try { unfinished = await sessionsStorage.findUnfinished(); } catch { return; }
  if (!unfinished) return;
  const ok = window.confirm(
    "中断したセッションがあります。再開しますか？\n\n" +
    "議題: " + unfinished.topic + "\n発言 " + unfinished.turns.length + " 件"
  );
  if (ok) {
    // レビュー: 壊れた保存データ（cursor欠落等）だと engine.restore() が例外を投げうる。
    //   捕まえないと、次回起動のたびに同じ「再開しますか」ダイアログと例外を繰り返す
    //   袋小路になる。復元に失敗したら stopped にして保存し直し、無限ループを断つ。
    try {
      await engine.restore(unfinished);
    } catch (e) {
      emit("log:append", { level: "ERROR", at: Date.now(),
        message: "中断したセッションを復元できませんでした: " + String(e?.message ?? e) });
      unfinished.status = "stopped";
      await sessionsStorage.save(unfinished).catch(() => {});
    }
  } else {
    unfinished.status = "stopped";
    await sessionsStorage.save(unfinished);
  }
})();

