// ui/controls.js — 議題入力・ラウンド数・開始 / 一時停止 / 再開 / 停止。

import { on, state, emit } from "../state.js";
import { $, el, clear } from "./dom.js";
import { PROVIDERS, DEFAULTS, defaultAgents, assignStances, estimateRequests,
         estimateTokensPerRequest, SAMPLE_TOPICS, expandSolo } from "../config.js";
import { loadSettings, hasKey } from "../storage/settings.js";
import { loadTopics, pushTopic } from "../storage/topics.js";

const MAX_TOPIC = 500;

export function currentConfig() {
  const st = loadSettings();
  const debate = { ...DEFAULTS, ...(st.debate ?? {}) };
  let agents = st.agents ?? defaultAgents(3, "mock");
  // FR-03-09: 参加AIが1体・ソロモードONなら、ここで複数ペルソナに展開してから
  //   通常どおりの複数エージェント構成としてエンジンに渡す（D-043）。
  agents = expandSolo(agents, debate.solo);
  // レビュー: ソロ展開後のエージェントは思考スタイルを持つ。対立型フォーマットで
  //   assignStances を無条件にかけると、思考スタイルと stance（賛成/反対）が
  //   機械的に矛盾する組み合わせで注入される。展開済み（solo）なら適用しない
  //   （prompts.js 側でも solo なら stance 指示を出さないよう二重にガードする）。
  //   D-070: 通常編成のペルソナ（FR-03-10）は stance と両立するので、判定は persona ではなく solo で行う。
  if (debate.format === "debate" && !agents.some((a) => a.solo)) agents = assignStances(agents);
  return { ...debate, agents };
}

export function mountControls(engine, onOpenSettings) {
  const topic = $("#topic");
  const count = $("#topic-count");
  const rounds = $("#rounds");
  const estimate = $("#req-estimate");
  const status = $("#run-status");
  const helpers = $("#topic-helpers");

  const btnStart = $("#btn-start");
  const btnPause = $("#btn-pause");
  const btnResume = $("#btn-resume");
  const btnStop = $("#btn-stop");
  // FR-05-07 / FR-05-08（D-070）: 司会の差し込みと追加ラウンド
  const modText = $("#mod-text");
  const btnInterject = $("#btn-interject");
  const extendN = $("#extend-n");
  const btnExtend = $("#btn-extend");

  function refreshEstimate() {
    // 実行中は同じ行に「実測 N req」を出しているので、推定で上書きしない
    // （usage:changed が入れた実測が、議題やラウンド数を触った拍子に消えていた）。
    if (state.status === "running" || state.status === "waiting" || state.status === "paused") return;
    const cfg = currentConfig();
    cfg.rounds = Number(rounds.value) || cfg.rounds;
    const est = estimateRequests(cfg);
    const tok = estimateTokensPerRequest({ ...cfg, topicLength: topic.value.length });
    estimate.textContent = "推定 " + est + " req / 上限 " + cfg.requestLimit +
      "（" + cfg.agents.length + "体）・1回あたり最大 約" + tok.toLocaleString() + " tok";
    // 無料枠の TPM は 6000〜12000 程度。1回で使い切る設定は警告する（D-021）
    estimate.dataset.over = String(est > cfg.requestLimit || tok > 6000);
  }

  function refreshCount() {
    if (topic.value.length > MAX_TOPIC) topic.value = topic.value.slice(0, MAX_TOPIC);
    count.textContent = topic.value.length + " / " + MAX_TOPIC;
  }

  function applyTopic(text) {
    topic.value = text.slice(0, MAX_TOPIC);
    refreshCount();
    refreshEstimate();
  }

  // FR-12-02/03: サンプル議題のチップと、過去に使った議題の履歴セレクト。
  function renderHelpers() {
    // レビュー: clear(helpers) は内部で helpers.firstChild を読むため、null ガードは
    //   clear() の前に無いと意味が無い（到達不能な死んだコードになっていた）。
    if (!helpers) return;
    clear(helpers);

    helpers.appendChild(el("span", { class: "ctl-label", text: "サンプル" }));
    for (const t of SAMPLE_TOPICS) {
      helpers.appendChild(el("button", {
        class: "btn-mini topic-chip", type: "button", text: t,
        onClick: () => applyTopic(t)
      }));
    }

    const history = loadTopics();
    if (history.length) {
      const sel = el("select", {
        class: "topic-history",
        onChange: (e) => {
          if (e.target.value) applyTopic(e.target.value);
          sel.value = "";   // 同じ項目を続けて選んでも change が発火するように戻す
        }
      }, [
        el("option", { value: "", text: "履歴から選ぶ（" + history.length + "）" }),
        ...history.map((t) => el("option", { value: t, text: t.length > 40 ? t.slice(0, 40) + "…" : t }))
      ]);
      helpers.appendChild(sel);
    }
  }

  function setButtons(st) {
    btnStart.disabled = st === "running" || st === "waiting" || st === "paused";
    btnPause.disabled = !(st === "running" || st === "waiting");
    btnResume.disabled = st !== "paused";
    btnStop.disabled = !(st === "running" || st === "waiting" || st === "paused");
    const has = Boolean(state.session);
    btnInterject.disabled = !(has && (st === "paused" || st === "done" || st === "stopped"));
    btnExtend.disabled = !(has && (st === "done" || st === "stopped"));
  }

  const STATUS_LABEL = {
    idle: "待機中", running: "実行中", waiting: "レート制限で待機中",
    paused: "一時停止", stopped: "停止", done: "終了", error: "エラー"
  };

  function setStatusText(st, extra) {
    status.textContent = (STATUS_LABEL[st] ?? st) + (extra ? "  " + extra : "");
    status.dataset.state = st;
  }

  // 推定トークン数は議題の長さも含めて出すため、議題を打つたびに引き直す
  topic.addEventListener("input", () => { refreshCount(); refreshEstimate(); });
  rounds.addEventListener("input", refreshEstimate);

  btnStart.addEventListener("click", async () => {
    const cfg = currentConfig();
    cfg.rounds = Number(rounds.value) || cfg.rounds;

    // AC-M08: キー未設定なら設定画面へ誘導する
    const missing = [...new Set(cfg.agents.map((a) => a.provider))]
      .filter((p) => PROVIDERS[p]?.needsKey && !hasKey(p));
    if (missing.length) {
      const names = missing.map((p) => PROVIDERS[p].label).join(" / ");
      setStatusText("idle", "APIキーが未設定です: " + names);
      onOpenSettings(missing[0]);
      return;
    }

    // FR-12-03: 議題の履歴に積む。engine.start() は完走まで待つ Promise を返すため、
    //   その await の前に記録する（一時停止・停止で終わっても「使った議題」として残す）。
    if (topic.value.trim()) { pushTopic(topic.value.trim()); renderHelpers(); }

    try {
      await engine.start({ topic: topic.value, config: cfg });
    } catch (e) {
      setStatusText("error", e.message);
    }
  });

  btnInterject.addEventListener("click", () => {
    const t = engine.interject(modText.value);
    if (t) modText.value = "";
  });
  modText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnInterject.disabled) { e.preventDefault(); btnInterject.click(); }
  });
  btnExtend.addEventListener("click", () => {
    Promise.resolve(engine.extend(Number(extendN.value) || 1)).catch((e) => {
      emit("log:append", { level: "WARN", at: Date.now(), message: "追加できません: " + e.message });
    });
  });

  btnPause.addEventListener("click", () => engine.pause());
  btnResume.addEventListener("click", () => {
    Promise.resolve(engine.resume()).catch((e) => setStatusText("error", e.message));
  });
  btnStop.addEventListener("click", () => engine.stop());

  on("engine:status", (st) => { setButtons(st); setStatusText(st); });
  on("wait:tick", (sec) => setStatusText("waiting", "あと " + sec + " 秒"));
  on("usage:changed", ({ requestCount, limit }) => {
    estimate.textContent = "実測 " + requestCount + " req / 上限 " + limit;
  });
  on("settings:changed", refreshEstimate);
  on("session:started", () => { if (state.session) rounds.value = state.session.config.rounds; });

  rounds.value = String(currentConfig().rounds);
  refreshCount();
  refreshEstimate();
  renderHelpers();
  setButtons("idle");
  setStatusText("idle");

  return { refreshEstimate };
}
