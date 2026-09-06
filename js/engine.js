// engine.js — 議論の状態機械とターンループ。副作用を持つ唯一のドメイン層モジュール。

import { state, emit, setStatus } from "./state.js";
import { computeOrder } from "./order.js";
import { roleOf, proposerFor } from "./roles.js";
import { buildContext, renderRoundPlain, truncate } from "./context.js";
import { backoffSec } from "./errors.js";
import { estimateRequests, DEFAULTS, HUMAN_ID } from "./config.js";
import { runEvaluation, judgeBiasWarning } from "./judge.js";

function deferred() {
  let fire;
  const p = new Promise((res) => { fire = res; });
  return { p, fire };
}

function pad(n) { return String(n).padStart(2, "0"); }

// D-018: 出力上限は maxChars から導く。固定 800 だと maxChars を下げても
//   レート枠（TPM）の消費が減らず、設定が効かなかった。
export function maxTokensFor(maxChars) {
  return Math.min(2000, Math.max(256, Math.round((maxChars ?? 400) * 2)));
}

// 同一プロセス内で直前に配ったID。秒までしか見ていなかった頃、開始→停止→開始を
// 1秒以内に行うと**同じIDになり、IndexedDB で先のセッションが黙って上書きされて消えた**
// （D-060）。ミリ秒まで含めたうえで、それでも並んだら連番で必ずずらす。
let lastSessionId = null;
let sameMsCount = 0;

function pad3(n) { return String(n).padStart(3, "0"); }

function newSessionId(now) {
  const d = new Date(now);
  const base = "s_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" +
               pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
               "_" + pad3(d.getMilliseconds());
  if (base === lastSessionId || (lastSessionId ?? "").startsWith(base + "-")) {
    sameMsCount += 1;
    const id = base + "-" + sameMsCount;
    lastSessionId = id;
    return id;
  }
  sameMsCount = 0;
  lastSessionId = base;
  return base;
}

export function createSession({ topic, config, seed, now }) {
  return {
    id: newSessionId(now),
    seed: seed >>> 0,
    createdAt: now,
    updatedAt: now,
    status: "running",
    topic,
    config: { ...DEFAULTS, ...config },
    roundOrder: {},
    proposers: {},        // ラウンドごとの提案役 roleIndex（D-033: ラウンド開始時に確定）
    turns: [],
    summaries: {},
    cursor: { round: 1, index: 0 },
    dropped: [],
    requestCount: 0,
    judgement: null,
    votes: null,
    issues: null,
    synthesis: null,      // FR-08-09: 議長による統合（D-070）
    errors: []
  };
}

export function createEngine({ callProvider, storage, clock, summarizer = null, getKey = () => "", usage = null }) {
  let summarizerRef = summarizer;   // 起動後に非同期で用意されるため差し替え可能にする
  let ac = null;          // 現在のターンの AbortController
  let waitAbort = null;   // waiting / バックオフ中の中断用
  let finishReason = null;

  // D-033: ループの世代。runLoop 起動のたびに増える。
  //   バックオフや待機の途中で pause→resume / stop→start されると、眠っていた旧ループが
  //   目覚めて新ループと並走し、同じターンを二重確定させる（レビュー #1/#2）。
  //   各ループは自分の世代とセッションを覚え、ずれていたら静かに退出する。
  let epoch = 0;

  const log = (level, message) => emit("log:append", { level, message, at: clock.now() });

  function session() { return state.session; }

  // 外部連携層は状態層を参照しない。予算はここで組み立てて注入する（BD §5.1）。
  function makeBudget(s) {
    return {
      check() {
        if (s.requestCount >= s.config.requestLimit) {
          // レビュー: 「再開」を押すだけでは requestCount が減らないため即座に同じ理由で
          //   再び一時停止する袋小路になっていた。設定を変える必要があることを明示する。
          throw {
            kind: "limit", status: 0, retryAfterSec: null,
            message: "セッションのリクエスト上限（" + s.config.requestLimit + "）に達しました。" +
              "「再開」しても上限に達したままなので進みません。設定でリクエスト上限を上げてから再開してください"
          };
        }
      },
      consume(provider) {
        s.requestCount += 1;
        usage?.increment(provider ?? "unknown");   // 日次カウント（成功・失敗を問わず）
        emit("usage:changed", { requestCount: s.requestCount, limit: s.config.requestLimit });
      }
    };
  }

  function setAgentStatus(agent, status) {
    agent.status = status;
    emit("agent:status", { agentId: agent.id, status });
  }

  function findAgent(s, id) { return s.config.agents.find((a) => a.id === id); }

  function isUnrecoverable(s) {
    const alive = s.config.agents.filter((a) => a.status !== "dropped");
    if (alive.length <= 1) return "参加AIが1体以下になった";
    if (s.config.format === "debate") {
      if (!alive.some((a) => a.stance === "for")) return "賛成側が全滅した";
      if (!alive.some((a) => a.stance === "against")) return "反対側が全滅した";
    }
    return null;
  }

  function dropAgent(s, agent, reason) {
    setAgentStatus(agent, "dropped");
    s.dropped.push({ agentId: agent.id, reason, at: clock.now() });
    log("WARN", agent.name + " が離脱しました（" + reason + "）");
    // roleIndex も roundOrder も変更しない。ループがスキップする（BD §4.4）。
    // 役割は次のラウンド開始時に生存メンバーで組み直される（FR-06-08 / D-033）。
  }

  // 状態遷移とターン確定は保存点（BD §8.1）。保存失敗で議論を止めない（D-029 / レビュー #3）。
  function persist(s) {
    if (!s) return Promise.resolve();
    return Promise.resolve(storage.save(s)).catch((e) => {
      log("WARN", "保存に失敗しました: " + String(e?.message ?? e));
    });
  }

  function finish(status, reason) {
    finishReason = reason;
    const s = session();
    if (s) { s.status = status; s.updatedAt = clock.now(); }
    setStatus(status);
    log(status === "error" ? "ERROR" : "INFO", "議論を終了しました（" + reason + "）");
    persist(s);
  }

  async function onRoundComplete(s, round) {
    const target = round - s.config.contextRounds;
    if (target < 1) return;
    if (s.summaries[target]) return;

    const text = renderRoundPlain(s, target);
    if (!text) return;

    let summary = null;
    if (summarizerRef && s.config.enableContextSummary) {
      try { summary = await summarizerRef.summarize(text); }
      catch { summary = null; }
    }
    // 失敗・未対応時は切り詰めで代替。呼び出し側からは常に文字列が入っている。
    s.summaries[target] = summary ?? truncate(text, 400);
    await persist(s);
  }

  // 中断可能な待機。pause()/stop() の waitAbort.fire() で即座に破棄される。
  // myWait の同一性で「古い sleep の tick」を無視する（レビュー #8）。
  async function interruptibleSleep(sec, { tick = false } = {}) {
    const myWait = deferred();
    waitAbort = myWait;
    await Promise.race([
      clock.sleep(sec, {
        onTick: (r) => { if (tick && waitAbort === myWait) emit("wait:tick", r); }
      }),
      myWait.p
    ]);
    if (waitAbort === myWait) waitAbort = null;
  }

  // 失敗として数え、しきい値に達したら離脱させる。複数の分岐から呼ぶ。
  function countFailure(s, agent, kind) {
    agent.failures += 1;
    agent.retries = 0;
    agent.transientRetries = 0;
    agent.emptyRetries = 0;
    agent.tokenBoost = 1;
    agent.rateWaitTotal = 0;   // 失敗ターンの待機累計を次のターンへ持ち越さない（D-007）
    if (agent.failures >= s.config.dropThreshold) {
      dropAgent(s, agent, kind);
      const r = isUnrecoverable(s);
      if (r) { finish("done", r); return; }
    } else {
      setAgentStatus(agent, "error");
    }
    s.cursor.index += 1;   // このターンは諦めて次へ
  }

  async function handleError(s, e, agent, live) {
    if (!live()) return;                // 旧世代のループ。副作用を残さず退出する（D-033）
    if (e.kind === "aborted") return;   // stop による中断。失敗として数えない。

    s.errors.push({ at: clock.now(), agentId: agent.id, kind: e.kind, message: e.message });
    log("ERROR", agent.name + ": " + e.kind + " " + (e.message ?? ""));

    switch (e.kind) {
      case "auth":
        setAgentStatus(agent, "error");
        finish("error", "APIキーが不正です");
        return;

      case "limit":
        pause(e.message);
        return;

      // D-022: コンテキストを送りすぎ。全員が同じ設定を共有しているので、
      //   1体だけ落としても残りが同じ壁に当たる。セッションごと止めて設定を直させる。
      case "toolarge":
        log("WARN", "議論設定を小さくしてください（1発言の文字数上限・全文で渡す直近ラウンド数・参加数）");
        finish("error", "コンテキストが大きすぎます");
        return;

      // D-024: 出力枠を思考トークンで使い切った状態。同じ枠で再試行しても必ず同じ結果になる。
      //   このAIに限って枠を倍にして1度だけ張り直す。それでも駄目なら失敗として数える。
      case "budget":
        if ((agent.tokenBoost ?? 1) < 4) {
          agent.tokenBoost = (agent.tokenBoost ?? 1) * 2;
          log("WARN", agent.name + " の出力枠が不足しました。枠を " +
            agent.tokenBoost + " 倍にして張り直します");
          return;
        }
        log("WARN", agent.name + " は枠を広げても本文を返しませんでした。" +
          "設定の「推論の深さ」を low にするか、推論モデル以外を選んでください");
        countFailure(s, agent, "budget");   // break は switch を抜けるだけで失敗計上に届かない
        return;

      case "config":
        // D-028: 後継モデルが案内されていれば、そのAIのモデルを差し替えて1度だけ張り直す。
        //   提供終了モデルはモデル一覧に残っていることがあり、選べてしまう。
        if (e.replacementModel && !agent.modelSwapped) {
          const from = agent.model;
          agent.model = e.replacementModel;
          agent.modelSwapped = true;
          log("WARN", agent.name + ": " + from + " は提供終了のため " + agent.model +
            " に切り替えて張り直します");
          emit("agent:model-swapped", { agentId: agent.id, from, to: agent.model });
          return;
        }
        // D-013: 設定の誤り。再試行しても直らないので即座に離脱させる。
        log("WARN", agent.name + " の設定を確認してください（モデル名が違うか、提供終了の可能性があります）");
        dropAgent(s, agent, "設定の誤り");
        {
          const r = isUnrecoverable(s);
          if (r) { finish("done", "設定の誤りで参加AIがいなくなりました"); return; }
        }
        s.cursor.index += 1;
        return;

      case "rate": {
        // D-017: API が待ち時間を明示してきたらそれに従う。境界を避けるため切り上げ＋1秒。
        const sec = e.retryAfterSec !== null && e.retryAfterSec !== undefined
          ? Math.ceil(e.retryAfterSec) + 1
          : backoffSec(++agent.retries);
        // D-007: 上限は1回の待機ではなく、そのターンの累計に対して見る。
        agent.rateWaitTotal = (agent.rateWaitTotal ?? 0) + sec;
        if (agent.rateWaitTotal > s.config.maxWaitSec) {
          pause("待機時間の累計が上限（" + s.config.maxWaitSec + "秒）を超えました");
          return;
        }
        setStatus("waiting");
        log("INFO", "レート制限のため " + sec + " 秒待機します" +
          (e.retryAfterSec != null ? "（APIの指示に従う）" : "（指数バックオフ）"));
        await interruptibleSleep(sec, { tick: true });
        if (!live()) return;
        if (state.status === "waiting") setStatus("running");
        return;   // 同じターンを再実行
      }

      case "empty":
        if (agent.emptyRetries === 0) { agent.emptyRetries = 1; return; }
        // 1回だけ再試行する。それでも空なら下の失敗系と同じ扱いにする
        // falls through
      case "server":
      case "network":
      case "timeout":
      case "parse":
        // レビュー: agent.retries は rate 分岐のバックオフ指数と共用していた。
        //   同じターン内で rate→server のように種別が入れ替わると、無関係な理由で
        //   3回の再試行枠を消費してしまい、本来より早く離脱してしまう。専用カウンタに分離。
        if (++agent.transientRetries < 3) {
          // D-033: このバックオフも中断可能にする。素の sleep だと pause/stop が
          //   効かず、旧ループが目覚めて並走する土壌になっていた（レビュー #1）。
          await interruptibleSleep(backoffSec(agent.transientRetries));
          return;
        }
        // falls through
      default:
        countFailure(s, agent, e.kind);
    }
  }

  // そのラウンドの提案役 roleIndex を確定して返す（rotation の通常ラウンドのみ）。
  // FR-06-08: 離脱後は生存メンバーで組み直す。確定済みならそれを使う（ラウンド途中の
  // 離脱で同一ラウンド内の役割が入れ替わらないように）。
  function proposerOf(s, round) {
    if (s.config.format !== "rotation" || round > s.config.rounds) return null;
    s.proposers = s.proposers ?? {};
    if (s.proposers[round] == null) s.proposers[round] = proposerFor(round, s.config);
    return s.proposers[round];
  }

  function roleFor(s, agent, round) {
    const p = proposerOf(s, round);
    if (p !== null) return agent.roleIndex === p ? "propose" : "critique";
    return roleOf(agent.roleIndex, round, s.config);
  }

  async function runLoop() {
    const myEpoch = ++epoch;
    const s = session();
    const live = () => myEpoch === epoch && state.session === s;
    const budget = makeBudget(s);
    const lastRound = s.config.rounds + (s.config.enableSummaryRound ? 1 : 0);

    try {
      while (state.status === "running" && live()) {
        const round = s.cursor.round;
        const index = s.cursor.index;

        if (round > lastRound) {
          // Phase 2: 完走したら審判が採点する（FR-09/FR-10）。失敗しても完走は妨げない。
          const jc = s.config.judge;
          if (jc?.enabled && jc.provider && jc.model && !s.judgement && s.turns.length > 0) {
            const warn = judgeBiasWarning(s, jc);
            if (warn) log("WARN", warn);   // B009: 自己贔屓バイアス
            log("INFO", "審判（" + jc.model + "）が採点しています…");
            try {
              // レビュー: signal を渡していなかったため、審判の評価中に stop() を押しても
              //   ac.abort() が効かず、フェッチがバックグラウンドで完走まで走り続けていた。
              ac = new AbortController();
              const ev = await runEvaluation({
                session: s, judgeCfg: jc, callProvider, budget, getKey,
                onLog: (m) => log("WARN", m), signal: ac.signal
              });
              // レビュー: live() は epoch としか比較せず state.status を見ないため、
              //   評価中に pause()/stop() されても while ループの外（ここ）では
              //   検知できず、"paused"/"stopped" が黙って "done" に上書きされていた。
              if (!live() || state.status !== "running") break;
              s.judgement = ev.judgement;
              s.issues = ev.issues;
              s.synthesis = ev.synthesis ?? null;
              // D-036: 後継モデルへ切り替わっていたら次回の既定にも反映する。
              //   ここで直さないと、新しいセッションのたびに同じ提供終了エラーを踏む。
              if (ev.swappedModel && ev.swappedModel !== jc.model) {
                s.config.judge.model = ev.swappedModel;
                log("INFO", "審判のモデルを " + ev.swappedModel + " に更新しました");
                emit("judge:model-swapped", { to: ev.swappedModel });
              }
              if (ev.error) log("WARN", ev.error);
              else log("INFO", jc.synthesize
                ? "採点・論点抽出・統合が終わりました（「結論」「判定」「論点」タブ）"
                : "採点と論点抽出が終わりました（「判定」「論点」タブ）");
              emit("evaluation:done", { judgement: s.judgement, issues: s.issues, synthesis: s.synthesis });
              await persist(s);
            } catch (e) {
              log("WARN", "審判の実行に失敗しました: " + String(e?.message ?? e));
            }
            if (!live() || state.status !== "running") break;
          }
          // D-023: 失敗だらけでも「完走」と出ると実態が伝わらない。件数を添える。
          const done = s.turns.length;
          const failed = s.errors.length;
          finish("done", failed ? "完走（発言 " + done + " 件・エラー " + failed + " 件）"
                                : "完走（発言 " + done + " 件）");
          break;
        }

        // ラウンド開始時に発言順と提案役を確定する（BD §4.6 / D-031 / D-033）
        if (!s.roundOrder[round]) {
          const p = proposerOf(s, round);
          const leadId = p !== null
            ? (s.config.agents.find((a) => a.status !== "dropped" && a.roleIndex === p)?.id ?? null)
            : null;
          s.roundOrder[round] =
            computeOrder(s.config.agents, round, s.config.order, s.seed, { leadId }).map((a) => a.id);
          emit("round:changed", { round, lastRound, rounds: s.config.rounds });
          log("INFO", round > s.config.rounds
            ? "総括ラウンドを開始します"
            : "ラウンド " + round + " / " + s.config.rounds + " を開始します");
        }

        const orderIds = s.roundOrder[round];

        if (index >= orderIds.length) {
          await onRoundComplete(s, round);
          if (!live()) break;
          s.cursor = { round: round + 1, index: 0 };
          continue;
        }

        const agent = findAgent(s, orderIds[index]);

        if (!agent || agent.status === "dropped") { s.cursor.index += 1; continue; }

        const reason = isUnrecoverable(s);
        if (reason) { finish("done", reason); break; }

        const role = roleFor(s, agent, round);
        const ctx = buildContext(s, agent, round, role);
        setAgentStatus(agent, "thinking");
        emit("turn:started", { round, index, agentId: agent.id, role });

        ac = new AbortController();
        let res;
        try {
          res = await callProvider(agent, ctx, {
            signal: ac.signal, budget, getKey,
            maxTokens: maxTokensFor(s.config.maxChars) * (agent.tokenBoost ?? 1),
            reasoningEffort: s.config.reasoningEffort ?? "low",
            timeoutMs: s.config.timeoutMs ?? 60000
          });
        } catch (err) {
          await handleError(s, err, agent, live);
          continue;
        }

        // 旧世代のループに届いた応答は捨てる。新ループが同じターンをやり直す（D-033）
        if (!live()) break;

        setAgentStatus(agent, "idle");
        agent.retries = 0;
        agent.transientRetries = 0;
        agent.emptyRetries = 0;
        agent.rateWaitTotal = 0;
        agent.tokenBoost = 1;
        agent.failures = 0;   // 離脱は「連続」失敗で判定する。成功したらリセット（FR-06-05）

        // D-020: finish_reason が "length" なら出力上限で文が途中で切れている。
        const truncated = res.finishReason === "length";
        if (truncated) {
          // D-021: 「文字数上限を上げろ」と言うと過去発言も伸びてレート制限に当たる。
          log("WARN", agent.name + " の発言が出力上限で途中で切れました。" +
            "文字数上限を上げると1回あたりのトークンも増えてレート制限に当たりやすくなります。" +
            "「全文で渡す直近ラウンド数」を減らすか、通信トポロジを絞るほうが安全です");
        }

        const turn = {
          round: round, index: index, agentId: agent.id, role: role,
          text: res.text, chars: res.text.length, truncated: truncated,
          tokensIn: res.usage?.tokensIn ?? null,
          tokensOut: res.usage?.tokensOut ?? null,
          elapsedMs: res.elapsedMs ?? null,
          at: clock.now()
        };
        s.turns.push(turn);
        s.updatedAt = turn.at;
        emit("turn:committed", turn);      // 確定＝保存点
        // D-029: カーソルを進めてから保存する。進める前に保存すると、復元時に
        //   確定済みの最後のターンをもう一度実行して発言が二重になる。
        s.cursor.index += 1;
        await persist(s);
      }
    } catch (e) {
      // 状態機械の脱出経路。ここで status を遷移させないと「実行中」のまま固まる（レビュー #3）
      if (live()) finish("error", "内部エラー: " + String(e?.message ?? e));
    }
    return { status: state.status, reason: finishReason, session: s };
  }

  function pause(reason) {
    if (state.status !== "running" && state.status !== "waiting") return;
    waitAbort?.fire();                 // 待機中なら残り時間を破棄する（BD §4.1）
    waitAbort = null;
    // FR-05-02: 一時停止は現在のターンの完了を待つ。進行中の応答は中断しない（レビュー #10）。
    setStatus("paused");
    if (session()) { session().status = "paused"; session().updatedAt = clock.now(); }
    log("INFO", reason ? "一時停止しました（" + reason + "）" : "一時停止しました");
    persist(session());
  }

  function stop() {
    waitAbort?.fire();
    waitAbort = null;
    ac?.abort();                       // 停止は打ち切り。進行中の応答も破棄する
    finish("stopped", "ユーザー操作により停止");
  }

  async function start({ topic, config, seed }) {
    if (!topic || !topic.trim()) throw new Error("議題が空です");
    const agents = config.agents ?? [];
    if (agents.length < 1) throw new Error("参加AIが選ばれていません");

    const merged = { ...DEFAULTS, ...config };
    const est = estimateRequests(merged);
    if (est > merged.requestLimit) {
      throw new Error(
        "推定リクエスト数 " + est + " がセッション上限 " + merged.requestLimit +
        " を超えます。ラウンド数か参加数を減らしてください"
      );
    }

    // stopped / done / error からの「開始」は新規セッションを作る（BD §4.1）
    const now = clock.now();
    const s = createSession({
      topic: topic.trim().slice(0, 500),
      config: merged,
      seed: seed ?? (now >>> 0),
      now: now
    });
    for (const a of s.config.agents) {
      a.status = "idle"; a.failures = 0; a.retries = 0; a.transientRetries = 0; a.emptyRetries = 0;
      a.rateWaitTotal = 0; a.tokenBoost = 1;
    }
    state.session = s;
    finishReason = null;
    emit("session:started", s);
    log("INFO", "議論を開始します（推定 " + est + " リクエスト・シード " + s.seed + "）");
    setStatus("running");
    await persist(s);
    return runLoop();
  }

  async function resume() {
    if (state.status !== "paused") return null;
    if (!session()) return null;
    session().status = "running";
    log("INFO", "再開します");
    setStatus("running");
    return runLoop();
  }

  // 保存済みセッションを復元する（BD §8.2）。cursor はそのまま。未確定ターンは turns に無い。
  async function restore(saved) {
    if (!saved) return null;
    if (state.status === "running" || state.status === "waiting") return null;
    ac?.abort();
    waitAbort?.fire();
    waitAbort = null;

    const s = saved;
    const wasLive = s.status === "running" || s.status === "waiting" || s.status === "paused";
    for (const a of s.config.agents) {
      if (a.status === "thinking" || a.status === "error") a.status = "idle";
      a.retries = 0; a.transientRetries = 0; a.emptyRetries = 0; a.rateWaitTotal = 0; a.tokenBoost = 1;
    }
    state.session = s;
    finishReason = null;

    emit("session:started", s);
    const lastRound = s.config.rounds + (s.config.enableSummaryRound ? 1 : 0);
    const shownRound = Math.min(s.cursor.round, lastRound);
    if (s.roundOrder[shownRound] || s.turns.length) {
      emit("round:changed", { round: shownRound, lastRound, rounds: s.config.rounds });
    }
    for (const t of s.turns) emit("turn:committed", t);
    for (const a of s.config.agents) emit("agent:status", { agentId: a.id, status: a.status });
    // 復元後もセッション消費の表示を正しく戻す（レビュー minor）
    emit("usage:changed", { requestCount: s.requestCount, limit: s.config.requestLimit });

    if (wasLive) {
      s.status = "paused";
      setStatus("paused");
      log("WARN", "中断された応答を破棄しました。「再開」で続きから進みます（発言 " +
        s.turns.length + " 件・ラウンド " + s.cursor.round + "）");
    } else {
      setStatus(s.status);
      log("INFO", "保存済みのセッションを開きました（" + s.status + "・発言 " + s.turns.length + " 件）");
    }
    emit("session:restored", s);
    return s;
  }

  function setSummarizer(s) { summarizerRef = s; }

  // FR-05-07（D-070）: 人間が司会として議論に差し込む。一時停止中か終了後にだけ受け付ける
  //   （進行中に積むと、いま作っているコンテキストと保存点の整合が崩れる）。
  //   発言（turn）として積むので、コンテキスト・保存・復元・書き出し・画面が既存の経路に乗る。
  //   index は負にして、AIのターン位置（round:index の一意性）と衝突させない。
  function interject(text) {
    const s = session();
    const t = String(text ?? "").trim().slice(0, 2000);
    if (!s || !t) return null;
    if (!["paused", "done", "stopped"].includes(state.status)) return null;
    // 終了後（cursor が最終ラウンドを越えている）は最後の通常ラウンドに置く。
    // そうしないと追加ラウンド（extend）のコンテキスト範囲から外れて誰にも読まれない。
    const round = Math.max(1, Math.min(s.cursor.round, s.config.rounds));
    const nth = s.turns.filter((x) => x.agentId === HUMAN_ID && x.round === round).length;
    const turn = {
      round, index: -1 - nth, agentId: HUMAN_ID, role: "moderator",
      text: t, chars: t.length, truncated: false,
      tokensIn: null, tokensOut: null, elapsedMs: null, at: clock.now()
    };
    s.turns.push(turn);
    s.updatedAt = turn.at;
    emit("turn:committed", turn);
    log("INFO", "司会として差し込みました。次の発言から参照されます");
    persist(s);
    return turn;
  }

  // FR-05-08（D-070）: 終わった議論にラウンドを足して続ける。
  //   以前の総括ラウンドと評価（採点・論点・結論）は「途中までの結論」になるので破棄し、
  //   新しい終点で作り直す。人間の投票（votes）は人間のものなので残す。
  async function extend(n) {
    const s = session();
    const add = Math.max(1, Math.min(10, Math.floor(Number(n) || 0)));
    if (!s) throw new Error("セッションがありません");
    if (!["done", "stopped"].includes(state.status)) throw new Error("終了した議論にだけ追加できます");
    const why = isUnrecoverable(s);
    if (why) throw new Error("続行できません（" + why + "）");

    const alive = s.config.agents.filter((a) => a.status !== "dropped").length;
    const jc = s.config.judge;
    const judgeReq = (jc?.enabled && jc.provider && jc.model)
      ? 2 + (jc.checkStability ? 1 : 0) + (jc.synthesize ? 1 : 0) : 0;
    const need = alive * (add + (s.config.enableSummaryRound ? 1 : 0)) + judgeReq;
    if (s.requestCount + need > s.config.requestLimit) {
      throw new Error("追加すると推定 " + (s.requestCount + need) + " リクエストになり、セッション上限 " +
        s.config.requestLimit + " を超えます。設定でリクエスト上限を上げてください");
    }

    const oldRounds = s.config.rounds;
    const stale = s.turns.filter((t) => t.round > oldRounds && t.agentId !== HUMAN_ID).length;
    s.turns = s.turns.filter((t) => t.round <= oldRounds || t.agentId === HUMAN_ID);
    for (const k of Object.keys(s.roundOrder)) if (Number(k) > oldRounds) delete s.roundOrder[k];
    for (const k of Object.keys(s.proposers ?? {})) if (Number(k) > oldRounds) delete s.proposers[k];
    for (const k of Object.keys(s.summaries ?? {})) if (Number(k) > oldRounds) delete s.summaries[k];
    s.judgement = null; s.issues = null; s.synthesis = null;
    s.config.rounds = oldRounds + add;
    s.cursor = { round: oldRounds + 1, index: 0 };
    for (const a of s.config.agents) {
      if (a.status === "error") a.status = "idle";
      a.failures = 0; a.retries = 0; a.transientRetries = 0; a.emptyRetries = 0;
      a.rateWaitTotal = 0; a.tokenBoost = 1;
    }
    s.status = "running";
    s.updatedAt = clock.now();
    finishReason = null;

    // 画面を作り直す（総括を消したので append だけでは表せない）。restore() と同じ手順。
    emit("session:started", s);
    for (const t of s.turns) emit("turn:committed", t);
    for (const a of s.config.agents) emit("agent:status", { agentId: a.id, status: a.status });
    emit("usage:changed", { requestCount: s.requestCount, limit: s.config.requestLimit });
    log("INFO", "ラウンドを " + add + " 追加して続けます（" + oldRounds + " → " + s.config.rounds +
      (stale ? "。以前の総括 " + stale + " 件と評価は破棄し、最後に作り直します" : "") + "）");
    setStatus("running");
    await persist(s);
    return runLoop();
  }

  return { start, pause, resume, stop, restore, runLoop, setSummarizer, interject, extend,
           get session() { return session(); } };
}
