// tests/all.js — 全テストの起動。CSP script-src 'self' のためインラインには書けない。

import { render } from "./runner.js";
import { run as runDom } from "./dom.test.js";
import { run as runState } from "./state.test.js";
import { run as runConfig } from "./config.test.js";
import { run as runMdlite } from "./mdlite.test.js";
import { run as runLog } from "./log.test.js";
import { run as runTopics } from "./topics.test.js";
import { run as runPresets } from "./presets.test.js";
import { run as runSettings } from "./settings.test.js";
import { run as runFilesave } from "./filesave.test.js";
import { run as runRoles } from "./roles.test.js";
import { run as runOrder } from "./order.test.js";
import { run as runContext } from "./context.test.js";
import { run as runErrors } from "./errors.test.js";
import { run as runProviders } from "./providers.test.js";
import { run as runEngine } from "./engine.test.js";
import { run as runGemini } from "./gemini.test.js";
import { run as runMarkdown } from "./markdown.test.js";
import { run as runSessions } from "./sessions.test.js";
import { run as runUsage } from "./usage.test.js";
import { run as runAnthropic } from "./anthropic.test.js";
import { run as runJsonx } from "./jsonx.test.js";
import { run as runJudge } from "./judge.test.js";
import { run as runPanels } from "./panels.test.js";

(async () => {
  try {
    runDom();
    runState();
    runConfig();
    runMdlite();
    runLog();
    runTopics();
    runPresets();
    runSettings();
    runFilesave();
    runRoles();
    runOrder();
    runContext();
    runErrors();
    runMarkdown();
    runUsage();
    runPanels();
    await runProviders();
    await runGemini();
    await runAnthropic();
    await runJsonx();
    await runJudge();
    await runSessions();
    await runEngine();
  } catch (e) {
    console.error("テストの実行自体が落ちました", e);
    document.getElementById("test-summary").textContent = "実行時エラー: " + e.message;
    return;
  }
  render(document.getElementById("test-summary"), document.getElementById("test-results"));
})();
