export class RendererUnresponsiveError extends Error {
  constructor(timeoutMs = 3_000) {
    super('云电脑里的 Chromium 页面无响应，系统正在自动恢复');
    this.name = 'RendererUnresponsiveError';
    this.code = 'DOTS_RENDERER_UNRESPONSIVE';
    this.timeoutMs = timeoutMs;
  }
}

/** Bound CDP calls and latch a renderer failure so pending work cannot pile up. */
export function createRendererHealthMonitor(timeoutMs = 3_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Renderer timeout must be a positive integer');
  let unresponsive = false;
  let activeProbe = null;

  function run(operation) {
    if (unresponsive) return Promise.reject(new RendererUnresponsiveError(timeoutMs));
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        unresponsive = true;
        reject(new RendererUnresponsiveError(timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve().then(operation), deadline]).finally(() => clearTimeout(timer));
  }

  function check(operation) {
    if (unresponsive) return Promise.resolve(false);
    if (activeProbe) return activeProbe;
    const currentProbe = run(operation)
      .then(() => true, () => false)
      .finally(() => { if (activeProbe === currentProbe) activeProbe = null; });
    activeProbe = currentProbe;
    return currentProbe;
  }

  return {
    run,
    check,
    fail() { unresponsive = true; },
    reset() {
      unresponsive = false;
      activeProbe = null;
    },
    get unresponsive() { return unresponsive; },
  };
}
