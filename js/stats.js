// stats.js — 保存済みセッションの横断集計（純関数・FR-07-08・D-078）。
//
// なぜ要るか: 1回の判定は信用できない。B001（MT-Bench）が GPT-4 審判の一致率を測るのに
//   3,000票 使っているのはそのため。AIGiron は安定性チェック（FR-08-07）・自己贔屓警告（B009）・
//   長さ相関（FR-08-08）と「この判定は疑わしい」と言う道具を揃えているが、**1セッションでは
//   どれも判断材料にならない**。溜まったセッションを横断して初めて意味を持つ。
//
// ここは純関数だけを置く。IndexedDB からの取得は storage/sessions.js、表示は ui/sessions.js。

// これ未満の件数では割合を出しても意味がない。表示側が注意書きを出すのに使う。
export const MIN_RELIABLE = 5;

export function modelKey(x) {
  return (x?.provider ?? "?") + " / " + (x?.model ?? "?");
}

// モックは実モデルではない。モックの審判は固定の規則で勝者を決めるので、
// 混ぜると勝率も一致率も自己贔屓も全部汚れる。**モックが1体でも絡むセッションは丸ごと除く**。
function usesMock(s) {
  if ((s?.config?.agents ?? []).some((a) => a?.provider === "mock")) return true;
  return s?.config?.judge?.provider === "mock";
}

// 集計に使えるのは「構造化された採点がある」セッションだけ（raw は形が保証されない）。
export function hasScores(s) {
  const j = s?.judgement;
  return Boolean(j && !j.raw && Array.isArray(j.scores) && j.scores.length);
}

// D-083: 採点が無い理由を分ける。**理由を出さないと「0 セッション」としか見えない**。
//   実際に踏んだ: 審判を設定して回したのにレート制限で採点が落ち、集計に何も入らず、
//   利用者には原因が分からなかった（D-082）。何件がどの理由で外れたかを必ず出す。
function excludeReason(s) {
  if (hasScores(s)) return null;
  const j = s?.judgement;
  if (j?.failed) return "failed";                      // 審判は動いたが失敗した
  if (j?.raw) return "unstructured";                   // 応答を構造化できなかった
  const jc = s?.config?.judge;
  if (!jc?.enabled || !jc.provider || !jc.model) return "noJudge";   // 審判を設定していない
  return "other";
}

function rate(n, d) { return d > 0 ? n / d : null; }

export function aggregate(sessions) {
  const all = Array.isArray(sessions) ? sessions : [];
  const mockSkipped = all.filter(usesMock).length;
  const real = all.filter((s) => s && !usesMock(s));
  const judged = real.filter(hasScores);

  // D-083: 採点が無いセッションの内訳。母数から消えた理由を画面に出すために数える。
  const excluded = { failed: 0, unstructured: 0, noJudge: 0, other: 0 };
  for (const s of real) {
    const r = excludeReason(s);
    if (r) excluded[r] += 1;
  }

  const models = new Map();   // key → 集計行
  const judges = new Map();

  const model = (k, seed) => {
    if (!models.has(k)) {
      models.set(k, { key: k, provider: seed.provider, model: seed.model,
        appearances: 0, aiWins: 0, scoreSum: 0, scoreCount: 0,
        humanWins: 0, humanVotes: 0, starSum: 0, starCount: 0 });
    }
    return models.get(k);
  };
  const judge = (k, seed) => {
    if (!judges.has(k)) {
      judges.set(k, { key: k, provider: seed.provider, model: seed.model,
        sessions: 0, stabilityChecked: 0, stabilityUnstable: 0,
        agreeBoth: 0, agreeSame: 0, selfCases: 0, selfWins: 0 });
    }
    return judges.get(k);
  };

  for (const s of judged) {
    const j = s.judgement;
    const agents = s.config?.agents ?? [];
    const byId = new Map(agents.map((a) => [a.id, a]));
    const votes = s.votes ?? null;
    const humanWinner = votes?.winnerAgentId ?? null;

    for (const a of agents) {
      const m = model(modelKey(a), a);
      m.appearances += 1;
      if (j.winnerAgentId === a.id) m.aiWins += 1;
      if (humanWinner) {
        m.humanVotes += 1;
        if (humanWinner === a.id) m.humanWins += 1;
      }
      const star = votes?.stars?.[a.id];
      if (Number.isFinite(star) && star > 0) { m.starSum += star; m.starCount += 1; }
    }

    // 得点は満点で正規化する（観点別は20点満点、旧形式は10点満点で混在しうる）
    for (const sc of j.scores) {
      const a = byId.get(sc.agentId);
      if (!a || !Number.isFinite(sc.score)) continue;
      const max = sc.maxScore ?? 10;
      if (max > 0) {
        const m = model(modelKey(a), a);
        m.scoreSum += sc.score / max;
        m.scoreCount += 1;
      }
    }

    const jc = s.config?.judge;
    if (jc?.provider && jc?.model) {
      const g = judge(modelKey(jc), jc);
      g.sessions += 1;
      if (j.stability?.checked === true) {
        g.stabilityChecked += 1;
        if (j.stability.unstable === true) g.stabilityUnstable += 1;
      }
      // B001 の agreement rate を、利用者個人に対してやる。
      // 両方に勝者があるときだけ数える（星だけ付けた回は対象外）。
      if (j.winnerAgentId && humanWinner) {
        g.agreeBoth += 1;
        if (j.winnerAgentId === humanWinner) g.agreeSame += 1;
      }
      // B009 自己贔屓: 審判と同じモデルの参加者がいた回と、そのうちその参加者が勝った回。
      const same = agents.filter((a) => modelKey(a) === g.key);
      if (same.length) {
        g.selfCases += 1;
        if (same.some((a) => a.id === j.winnerAgentId)) g.selfWins += 1;
      }
    }
  }

  const modelRows = [...models.values()].map((m) => ({
    ...m,
    aiWinRate: rate(m.aiWins, m.appearances),
    humanWinRate: rate(m.humanWins, m.humanVotes),
    avgScore: rate(m.scoreSum, m.scoreCount),
    avgStars: rate(m.starSum, m.starCount)
  })).sort((a, b) => b.appearances - a.appearances || a.key.localeCompare(b.key));

  const judgeRows = [...judges.values()].map((g) => ({
    ...g,
    unstableRate: rate(g.stabilityUnstable, g.stabilityChecked),
    agreeRate: rate(g.agreeSame, g.agreeBoth),
    selfWinRate: rate(g.selfWins, g.selfCases)
  })).sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));

  return {
    total: all.length,
    mockSkipped,
    excluded,
    judged: judged.length,
    voted: judged.filter((s) => s.votes?.winnerAgentId).length,
    reliable: judged.length >= MIN_RELIABLE,
    models: modelRows,
    judges: judgeRows
  };
}

// 表示用。null（母数が0）は「—」にする。割合を勝手に 0% と書かない。
export function pct(v) {
  return v === null || v === undefined ? "—" : Math.round(v * 100) + "%";
}
