// ui/header.js — 参加AIのチップとラウンド表示。class と textContent の差し替えのみ。

import { on, state } from "../state.js";
import { el, clear } from "./dom.js";
import { AGENT_SHAPES } from "../config.js";

export function mountHeader(agentsRoot, roundRoot) {
  const chips = new Map();

  function build(s) {
    clear(agentsRoot);
    chips.clear();
    for (const a of s.config.agents) {
      const cls = "agent-" + a.colorIndex;
      const chip = el("span", { class: "chip " + cls, dataset: { status: a.status } }, [
        el("span", { class: "chip-shape", text: AGENT_SHAPES[a.shapeIndex] }),
        el("span", { class: "chip-name", text: a.name })
      ]);
      chips.set(a.id, chip);
      agentsRoot.appendChild(chip);
    }
  }

  on("session:started", (s) => {
    build(s);
    roundRoot.textContent = "ROUND - / " + s.config.rounds;
  });

  on("agent:status", ({ agentId, status }) => {
    const chip = chips.get(agentId);
    if (chip) chip.dataset.status = status;
  });

  on("round:changed", ({ round, rounds }) => {
    roundRoot.textContent = round > rounds
      ? "総括ラウンド"
      : "ROUND " + round + " / " + rounds;
  });

  on("engine:status", (st) => {
    if (!state.session) return;
    if (st === "done" || st === "stopped" || st === "error") {
      for (const [id, chip] of chips) {
        if (chip.dataset.status === "thinking") chip.dataset.status = "idle";
      }
    }
  });
}
