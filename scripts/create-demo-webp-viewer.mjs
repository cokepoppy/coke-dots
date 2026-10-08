import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const source = resolve(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
assert(process.argv[2] && process.argv[3], 'Usage: node scripts/create-demo-webp-viewer.mjs <animated.webp> <output.html>');

const bytes = await readFile(source);
assert(bytes.length > 100_000, 'The WebP file is unexpectedly small.');
const encoded = bytes.toString('base64');
const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f8f8f7">
  <title>Coke Dots · 云电脑主动工作演示</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #242424; background: #f8f8f7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 36px 20px 48px; }
    main { width: min(1120px, 100%); margin: 0 auto; }
    header { margin: 0 0 22px; }
    .eyebrow { margin: 0 0 9px; color: #7165a9; font-size: 13px; font-weight: 650; letter-spacing: .04em; }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 34px); line-height: 1.25; letter-spacing: -.025em; }
    .summary { max-width: 830px; margin: 11px 0 0; color: #666; font-size: 15px; line-height: 1.75; }
    .player { overflow: hidden; border: 1px solid #e3e1de; border-radius: 18px; background: #fff; box-shadow: 0 14px 40px #24242410; }
    .player img { display: block; width: 100%; height: auto; }
    .caption { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 18px; border-top: 1px solid #eee; color: #646464; font-size: 13px; }
    .playing { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #70a982; box-shadow: 0 0 0 3px #70a98220; }
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0 0; }
    .step { min-height: 62px; padding: 12px 14px; border: 1px solid #e9e7e4; border-radius: 12px; background: #fff; color: #505050; font-size: 13px; line-height: 1.55; }
    .step b { display: block; margin-bottom: 3px; color: #282828; font-size: 12px; }
    footer { margin-top: 15px; color: #888; font-size: 12px; line-height: 1.6; }
    @media (max-width: 720px) { body { padding: 22px 12px 30px; } .player { border-radius: 12px; } .caption { align-items: flex-start; flex-direction: column; } .steps { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">COKE DOTS · PERSONAL AGENT</p>
      <h1>云电脑里的主动工作</h1>
      <p class="summary">Dot 按每小时计划检查公开活动信息，在 Debian 云电脑中打开页面并点击查看详情，再用中文汇报结果。视频已剪去启动和模型等待过程，展示完整的可见工作流程。</p>
    </header>
    <section class="player" aria-label="演示视频">
      <img id="demo" alt="Dot 在 Debian 云电脑中查看活动详情，并在 Activity 汇报结果和确认每小时后续计划" src="data:image/webp;base64,${encoded}">
      <div class="caption"><span>11 秒 · 自动循环 · 中文任务与汇报</span><span class="playing"><i class="dot"></i>正在播放</span></div>
    </section>
    <section class="steps" aria-label="演示步骤">
      <div class="step"><b>1 · 接收目标</b>用户用中文交代定时检查任务</div>
      <div class="step"><b>2 · 云电脑操作</b>Pi 在 Debian 桌面查看公开页面并点击详情</div>
      <div class="step"><b>3 · 主动汇报</b>完成后在 Activity 用中文报告发现</div>
      <div class="step"><b>4 · 持续跟进</b>确认每小时执行的后续计划</div>
    </section>
    <footer>演示使用隔离的合成活动页面与测试数据；不会进行真实注册、账户修改或支付。</footer>
  </main>
  <script>
    const image = document.getElementById('demo');
    image.addEventListener('error', () => { document.querySelector('.playing').textContent = '视频载入失败'; });
  </script>
</body>
</html>
`;

await writeFile(output, page, { mode: 0o644 });
console.log(`Created ${basename(output)} (${(Buffer.byteLength(page) / 1024).toFixed(0)} KiB) from ${basename(source)} in ${dirname(output)}.`);
