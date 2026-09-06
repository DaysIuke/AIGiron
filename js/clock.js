// clock.js — 時間に関する副作用。テストで差し替えるため独立させる。

export const realClock = {
  now: () => Date.now(),

  sleep(sec, { onTick } = {}) {
    return new Promise((resolve) => {
      let remain = Math.ceil(sec);
      if (onTick) onTick(remain);
      const tick = setInterval(() => {
        remain -= 1;
        if (onTick) onTick(Math.max(0, remain));
      }, 1000);
      setTimeout(() => { clearInterval(tick); resolve(); }, Math.max(0, sec * 1000));
    });
  }
};

// テスト用。待機を即座に解決し、要求された秒数を記録する。
export function createFakeClock() {
  const slept = [];
  let t = 0;
  return {
    slept,
    now: () => (t += 1000),
    async sleep(sec, { onTick } = {}) { slept.push(sec); if (onTick) onTick(0); }
  };
}
