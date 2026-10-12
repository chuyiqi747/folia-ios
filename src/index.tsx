import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
// @ts-ignore
globalThis.Buffer = Buffer;
installGlobalVisualizerFrameRateLimiter();

// 动态导入 bootstrap（要等 Buffer shim 装好之后才能执行）。
//
// 这里【必须】显式 catch。原来是 `void import('./bootstrap')`：
// 一旦这个模块加载失败或解析失败，就变成一个没人处理的 Promise rejection，
// 界面直接黑屏且零提示 —— 这正是我们排查了半天的那个现象。
import('./bootstrap').catch((error: unknown) => {
  console.error('[Folia] failed to load ./bootstrap', error);
  const report = (window as unknown as {
    __folia_report_boot_error__?: (err: unknown) => void;
  }).__folia_report_boot_error__;
  if (typeof report === 'function') {
    report(error);
  }
});
