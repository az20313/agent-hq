#!/usr/bin/env node
/**
 * perf-8904.js — AGENT HQ 页面性能基线采集（默认 8904，可用于 8901 对比）
 *
 * 零第三方依赖：Node >= 22（内置 fetch / WebSocket），自实现 CDP 客户端。
 * 通过 Chrome DevTools Protocol 打开页面，预热后按固定时长采样：
 *   1) FPS：requestAnimationFrame 帧计数，平均 / 1s 窗口最低 / 1s 窗口中位
 *   2) 帧间隔：p50 / p95 / p99 / max，>50ms 与 >100ms 卡顿次数
 *   3) 长任务：PerformanceObserver('longtask')，采样窗口内的次数/总时长/最长/p95
 *   4) JS 堆：performance.memory 的 usedJSHeapSize（开始 / 结束 / 增量）
 *   5) DOM 节点数、canvas 尺寸（像素与 CSS 尺寸）
 *   6) 页面错误数：window error + unhandledrejection（自页面脚本执行前注入）
 *
 * 用法：
 *   node scripts/perf-8904.js
 *   node scripts/perf-8904.js --url=http://127.0.0.1:8901/ --seconds=10 --settle=5000
 *   node scripts/perf-8904.js --url=http://127.0.0.1:8904/ --json
 *
 * 参数：
 *   --url <url>        页面地址（默认 http://127.0.0.1:8904/）
 *   --seconds <n>      采样时长，秒（默认 10）
 *   --settle <ms>      页面 load 后预热等待，毫秒（默认 5000）
 *   --json             只向 stdout 输出 JSON（进度日志走 stderr）
 *   --port <n>         CDP 端口（默认 9333；脚本会在端口未监听时自行启动 Chrome）
 *   --no-launch        端口未监听时报错，不自动启动 Chrome
 *   --width/--height   自动启动 Chrome 时的窗口外框尺寸（默认 1920x1000）
 *   --keep-tab         采样结束后保留标签页（默认关闭）
 *   --help, -h         显示本说明
 *
 * 说明：
 *   - 不同页面的对比应在同一浏览器实例、同一窗口尺寸、同一台机器上先后运行；
 *     脚本不会修改被测页面，只读取公开的浏览器性能接口。
 *   - performance.memory 为 Chrome 的量化值（约 100KB 粒度），只用于观察趋势。
 *   - 页面不可见（visibilityState=hidden）时 rAF 会被浏览器节流，结果不可用，
 *     脚本会在 JSON 的 warnings 中标注。
 *   - 不判定“性能好/差”，只输出测量数字；浏览器不支持的指标标记为“不支持”。
 *
 * 退出码：0 采集成功；2 参数或运行错误。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ------------------------------------------------------------------ 参数

const DEFAULTS = {
  url: 'http://127.0.0.1:8904/',
  seconds: 10,
  settle: 5000,
  port: 9333,
  width: 1920,
  height: 1000,
  json: false,
  launch: true,
  keepTab: false,
  help: false,
};

function usage() {
  const head = fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
  return head
    .replace(/^#![^\n]*\n/, '')
    .replace(/^\/\*\*?/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trimEnd();
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const numberArgs = new Set(['seconds', 'settle', 'port', 'width', 'height']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error('无法识别的参数: ' + arg);
    const body = arg.slice(2);
    if (!body) throw new Error('无法识别的参数: --');
    const eq = body.indexOf('=');
    let key;
    let value;
    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    if (key === 'json') opts.json = value !== 'false';
    else if (key === 'launch') opts.launch = value !== 'false';
    else if (key === 'no-launch') opts.launch = false;
    else if (key === 'keep-tab') opts.keepTab = true;
    else if (key === 'url') opts.url = String(value);
    else if (numberArgs.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('--' + key + ' 需要数字，收到: ' + value);
      opts[key] = n;
    } else throw new Error('无法识别的参数: --' + key);
  }
  if (opts.seconds <= 0) throw new Error('--seconds 必须大于 0');
  if (opts.settle < 0) throw new Error('--settle 不能为负数');
  if (opts.port < 1 || opts.port > 65535) throw new Error('--port 超出范围');
  opts.url = String(opts.url).replace(/\/+$/, '') + '/';
  return opts;
}

let OPTIONS;
try {
  OPTIONS = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error('[perf-8904] ' + err.message);
  console.error('使用 --help 查看用法。');
  process.exit(2);
}

if (OPTIONS.help) {
  console.log(usage());
  process.exit(0);
}

const log = (msg) => console.error('[perf-8904] ' + msg);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ CDP 客户端（自实现）

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP 连接已关闭 (id=' + id + ')'));
      }
      this.pending.clear();
    });
  }

  static connect(wsUrl, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(new Error('无法创建 CDP WebSocket: ' + err.message));
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) { /* ignore */ }
        reject(new Error('CDP 连接超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      }, { once: true });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败（请确认 Chrome 已用 --remote-debugging-port 启动）'));
      }, { once: true });
    });
  }

  _onMessage(event) {
    let text;
    if (typeof event.data === 'string') text = event.data;
    else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString('utf8');
    else return;

    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || ('CDP 错误 code=' + msg.error.code)));
      else entry.resolve(msg.result);
      return;
    }

    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) for (const fn of [...set]) fn(msg.params || {});
    }
  }

  send(method, params = {}, timeoutMs = 180000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭: ' + method));
    const id = ++this.seq;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 调用超时（' + timeoutMs + 'ms）: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error('等待事件超时: ' + method));
      }, timeoutMs);
    });
  }

  close() {
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

// ------------------------------------------------------------------ HTTP 辅助

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
  return res.json();
}

async function cdpVersion(port) {
  try {
    const body = await fetchJson('http://127.0.0.1:' + port + '/json/version', {
      signal: AbortSignal.timeout(2000),
    });
    return body;
  } catch (_) {
    return null;
  }
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

async function ensureBrowser(opts) {
  const existing = await cdpVersion(opts.port);
  if (existing) {
    log('复用已运行的 Chrome（CDP ' + opts.port + '，' + existing.Browser + '）');
    return existing;
  }
  if (!opts.launch) throw new Error('CDP 端口 ' + opts.port + ' 未监听，且已指定 --no-launch');

  const exe = findChrome();
  if (!exe) throw new Error('未找到 Chrome，可设置 CHROME_PATH 环境变量');

  const profileDir = path.join(os.tmpdir(), 'openclaw-perf-8904-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  log('启动 Chrome（CDP ' + opts.port + '，窗口 ' + opts.width + 'x' + opts.height + '）…');
  const child = spawn(exe, [
    '--remote-debugging-port=' + opts.port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=' + opts.width + ',' + opts.height,
    '--window-position=0,0',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(300);
    const info = await cdpVersion(opts.port);
    if (info) {
      log('Chrome 已就绪：' + info.Browser);
      return info;
    }
  }
  throw new Error('启动 Chrome 后 25s 内未监听 CDP 端口 ' + opts.port);
}

async function newPage(port) {
  const url = 'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank');
  let res = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!res.ok && res.status === 405) {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  }
  if (!res.ok) throw new Error('新建标签页失败: HTTP ' + res.status);
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) throw new Error('新建标签页未返回 webSocketDebuggerUrl');
  return target;
}

async function closePage(port, id) {
  try {
    await fetch('http://127.0.0.1:' + port + '/json/close/' + encodeURIComponent(id), {
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* 忽略清理失败 */ }
}

// ------------------------------------------------------------------ 页面内代码

// 在页面任何脚本执行前注入：错误收集 + 长任务观察
const HARNESS_SOURCE = `(() => {
  if (window.__perf8904) return;
  const h = window.__perf8904 = {
    errors: [],
    longtasks: [],
    longtaskSupported: false,
    injectedAt: performance.now()
  };
  window.addEventListener('error', (e) => {
    h.errors.push({
      kind: 'error',
      message: String((e && e.message) || (e.error && e.error.message) || 'unknown'),
      source: String((e && e.filename) || ''),
      line: Number((e && e.lineno) || 0),
      ts: performance.now()
    });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    let message = '';
    try {
      const r = e && e.reason;
      message = r && (r.stack || r.message) ? String(r.stack || r.message) : String(r);
    } catch (_) {
      message = 'unserializable rejection';
    }
    h.errors.push({ kind: 'unhandledrejection', message: message, source: '', line: 0, ts: performance.now() });
  });
  try {
    if (typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.indexOf('longtask') !== -1) {
      h.longtaskSupported = true;
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          h.longtasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
        }
      });
      po.observe({ type: 'longtask', buffered: true });
      h.po = po;
    }
  } catch (_) {
    h.longtaskSupported = false;
  }
})();`;

const ENV_EXPRESSION = `(() => {
  const glCanvas = document.createElement('canvas');
  glCanvas.width = 1;
  glCanvas.height = 1;
  let gpu = null;
  try {
    const gl = glCanvas.getContext('webgl2') || glCanvas.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const attrs = gl.getContextAttributes ? gl.getContextAttributes() : null;
      gpu = {
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        antialias: attrs ? !!attrs.antialias : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
      };
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch (err) {
    gpu = { error: String(err && err.message || err) };
  }
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const paints = {};
  for (const p of performance.getEntriesByType('paint')) paints[p.name] = p.startTime;
  const canvases = Array.prototype.map.call(document.querySelectorAll('canvas'), (c) => ({
    width: c.width,
    height: c.height,
    clientWidth: c.clientWidth,
    clientHeight: c.clientHeight
  }));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      dpr: window.devicePixelRatio
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth
    },
    ua: navigator.userAgent,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    memorySupported: !!performance.memory,
    longtaskSupported: !!(window.__perf8904 && window.__perf8904.longtaskSupported),
    gpu: gpu,
    navigation: nav ? {
      type: nav.type,
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      transferSize: nav.transferSize,
      encodedBodySize: nav.encodedBodySize,
      decodedBodySize: nav.decodedBodySize
    } : null,
    paints: paints,
    dom: {
      nodes: document.getElementsByTagName('*').length,
      canvases: canvases
    }
  };
})()`;

function measureExpression(seconds) {
  return `(async () => {
    const h = window.__perf8904 || { errors: [], longtasks: [], longtaskSupported: false };
    const readMem = () => performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit
    } : null;
    const heapStart = readMem();
    const visibilityStart = document.visibilityState;
    const t0 = performance.now();
    const frames = [];
    await new Promise((resolve) => {
      const deadline = t0 + ${Math.round(seconds * 1000)};
      function tick(ts) {
        frames.push(ts);
        if (ts < deadline) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    const t1 = performance.now();
    const heapEnd = readMem();
    const errorsAll = h.errors ? h.errors.slice() : [];
    const longtasks = (h.longtasks || []).filter((e) => e.start >= t0 && e.start <= t1);
    const canvases = Array.prototype.map.call(document.querySelectorAll('canvas'), (c) => ({
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight
    }));
    return {
      t0: t0,
      t1: t1,
      frames: frames,
      heapStart: heapStart,
      heapEnd: heapEnd,
      errorsAll: errorsAll,
      errorsInWindow: errorsAll.filter((e) => e.ts >= t0 && e.ts <= t1),
      longtaskSupported: !!h.longtaskSupported,
      longtasks: longtasks,
      domNodes: document.getElementsByTagName('*').length,
      canvases: canvases,
      visibilityStart: visibilityStart,
      visibilityEnd: document.visibilityState,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      dpr: window.devicePixelRatio
    };
  })()`;
}

async function evaluate(cdp, expression, awaitPromise = true, timeoutMs = 180000) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: false,
  }, timeoutMs);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面脚本异常: ' + (d.exception?.description || d.text || 'unknown'));
  }
  return res.result ? res.result.value : undefined;
}

// ------------------------------------------------------------------ 统计

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx];
}

function round(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function fpsWindows(frames, windowMs = 1000, stepMs = 100) {
  const out = [];
  if (frames.length < 2) return out;
  const first = frames[0];
  const last = frames[frames.length - 1];
  for (let start = first; start + windowMs <= last; start += stepMs) {
    const end = start + windowMs;
    let count = 0;
    for (const t of frames) if (t >= start && t < end) count += 1;
    out.push(count * (1000 / windowMs));
  }
  return out;
}

function summarize(raw) {
  const frames = (raw.frames || []).slice().sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i] - frames[i - 1]);
  const sortedIntervals = intervals.slice().sort((a, b) => a - b);

  const elapsedMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
  const avgFps = elapsedMs > 0 ? ((frames.length - 1) * 1000) / elapsedMs : null;

  const windows = fpsWindows(frames);
  const sortedWindows = windows.slice().sort((a, b) => a - b);

  const durations = (raw.longtasks || []).map((t) => t.duration).sort((a, b) => a - b);

  const heap = raw.heapStart && raw.heapEnd ? {
    supported: true,
    startUsedBytes: raw.heapStart.used,
    endUsedBytes: raw.heapEnd.used,
    deltaBytes: raw.heapEnd.used - raw.heapStart.used,
    totalBytes: raw.heapEnd.total,
    limitBytes: raw.heapEnd.limit,
  } : { supported: false };

  return {
    fps: {
      frames: frames.length,
      elapsedMs: round(elapsedMs, 1),
      avg: round(avgFps, 2),
      min1s: sortedWindows.length ? round(sortedWindows[0], 1) : null,
      median1s: sortedWindows.length ? round(percentile(sortedWindows, 50), 1) : null,
      max1s: sortedWindows.length ? round(sortedWindows[sortedWindows.length - 1], 1) : null,
      windows: windows.length,
      windowDefinition: '1s 窗口，步长 100ms；值为窗口内 rAF 帧数',
    },
    frameIntervalMs: {
      p50: round(percentile(sortedIntervals, 50), 2),
      p95: round(percentile(sortedIntervals, 95), 2),
      p99: round(percentile(sortedIntervals, 99), 2),
      max: sortedIntervals.length ? round(sortedIntervals[sortedIntervals.length - 1], 2) : null,
      over50ms: intervals.filter((v) => v > 50).length,
      over100ms: intervals.filter((v) => v > 100).length,
    },
    longTasks: {
      supported: !!raw.longtaskSupported,
      count: durations.length,
      totalMs: round(durations.reduce((a, b) => a + b, 0), 1),
      maxMs: durations.length ? round(durations[durations.length - 1], 1) : null,
      p95Ms: round(percentile(durations, 95), 1),
      entries: (raw.longtasks || []).slice(0, 50).map((t) => ({
        startMs: round(t.start - raw.t0, 1),
        durationMs: round(t.duration, 1),
        name: t.name,
      })),
    },
    heap,
    dom: {
      nodes: raw.domNodes,
      canvases: (raw.canvases || []).map((c) => ({
        buffer: c.width + 'x' + c.height,
        css: c.clientWidth + 'x' + c.clientHeight,
      })),
    },
    errors: {
      totalSinceNavigation: (raw.errorsAll || []).length,
      inWindow: (raw.errorsInWindow || []).length,
      items: (raw.errorsAll || []).slice(0, 20).map((e) => ({
        kind: e.kind,
        message: e.message.slice(0, 300),
        source: e.source,
        line: e.line,
      })),
    },
    visibility: {
      start: raw.visibilityStart,
      end: raw.visibilityEnd,
    },
  };
}

// ------------------------------------------------------------------ 输出

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

function humanSummary(result) {
  const { meta, env, load, metrics, warnings } = result;
  const m = metrics;
  const lines = [];
  lines.push('');
  lines.push('=== AGENT HQ 性能基线 ===');
  lines.push(pad('URL') + meta.url);
  lines.push(pad('采集时间') + new Date(result.startedAt).toLocaleString('zh-CN', { hour12: false }) + '（本地时区）');
  lines.push(pad('浏览器') + meta.browser + '  CDP:' + meta.cdpPort);
  lines.push(pad('窗口/视口') + env.viewport.outerWidth + 'x' + env.viewport.outerHeight + ' / ' +
    env.viewport.innerWidth + 'x' + env.viewport.innerHeight + '  DPR=' + env.viewport.dpr);
  lines.push(pad('屏幕') + env.screen.width + 'x' + env.screen.height +
    '（可用 ' + env.screen.availWidth + 'x' + env.screen.availHeight + '）');
  lines.push(pad('GPU') + (env.gpu && env.gpu.renderer ? env.gpu.renderer : '不支持'));
  lines.push(pad('采样') + '预热 ' + meta.settleMs + ' ms + 采样 ' + meta.seconds + ' s（rAF）');
  lines.push(pad('页面可见性') + m.visibility.start + ' → ' + m.visibility.end);
  if (load) {
    lines.push(pad('加载') + 'DCL ' + round(load.domContentLoaded, 0) + ' ms / load ' +
      round(load.load, 0) + ' ms / FCP ' + (load.firstContentfulPaint === null || load.firstContentfulPaint === undefined
        ? '未记录' : round(load.firstContentfulPaint, 0) + ' ms'));
  }
  lines.push('');
  lines.push(pad('FPS') + (m.fps.avg === null ? '不支持' : '平均 ' + m.fps.avg +
    ' / 最低(1s 窗) ' + (m.fps.min1s ?? '不支持') + ' / 中位(1s 窗) ' + (m.fps.median1s ?? '不支持')));
  lines.push(pad('帧数/时长') + m.fps.frames + ' 帧 / ' + m.fps.elapsedMs + ' ms');
  lines.push(pad('帧间隔') + 'p50 ' + (m.frameIntervalMs.p50 ?? '不支持') + ' ms / p95 ' +
    (m.frameIntervalMs.p95 ?? '不支持') + ' ms / p99 ' + (m.frameIntervalMs.p99 ?? '不支持') +
    ' ms / max ' + (m.frameIntervalMs.max ?? '不支持') + ' ms');
  lines.push(pad('卡顿') + '>' + 50 + 'ms ' + m.frameIntervalMs.over50ms + ' 次；>100ms ' +
    m.frameIntervalMs.over100ms + ' 次');
  if (m.longTasks.supported) {
    lines.push(pad('长任务') + m.longTasks.count + ' 次，合计 ' + m.longTasks.totalMs +
      ' ms，最长 ' + (m.longTasks.maxMs === null ? '—' : m.longTasks.maxMs + ' ms') +
      '，p95 ' + (m.longTasks.p95Ms === null ? '—' : m.longTasks.p95Ms + ' ms'));
  } else {
    lines.push(pad('长任务') + '不支持');
  }
  if (m.heap.supported) {
    lines.push(pad('JS 堆') + fmtMB(m.heap.startUsedBytes) + ' → ' + fmtMB(m.heap.endUsedBytes) +
      '（Δ ' + (m.heap.deltaBytes >= 0 ? '+' : '') + fmtMB(m.heap.deltaBytes) +
      '；上限 ' + fmtMB(m.heap.limitBytes) + '）');
  } else {
    lines.push(pad('JS 堆') + '不支持');
  }
  lines.push(pad('DOM') + m.dom.nodes + ' 节点；canvas ' +
    (m.dom.canvases.length ? m.dom.canvases.map((c) => c.buffer + '（CSS ' + c.css + '）').join('，') : '无'));
  lines.push(pad('页面错误') + m.errors.totalSinceNavigation + '（采样窗口内 ' + m.errors.inWindow + '）');
  if (warnings.length) {
    lines.push('');
    for (const w of warnings) lines.push('⚠ ' + w);
  }
  lines.push('');
  return lines.join('\n');
}

function pad(label) {
  const width = 14;
  const text = label + '：';
  return text + ' '.repeat(Math.max(1, width - text.length));
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const startedAt = new Date();
  const startedClock = Date.now();

  const browser = await ensureBrowser(OPTIONS);
  const target = await newPage(OPTIONS.port);
  log('标签页 ' + target.id + ' 已创建');

  let cdp = null;
  let result;
  try {
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache').catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HARNESS_SOURCE });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

    const loadPromise = cdp.once('Page.loadEventFired', 40000).catch(() => null);
    log('打开 ' + OPTIONS.url);
    const nav = await cdp.send('Page.navigate', { url: OPTIONS.url });
    if (nav.errorText) throw new Error('页面导航失败: ' + nav.errorText);
    await loadPromise;

    const deadline = Date.now() + 20000;
    let ready = '';
    while (Date.now() < deadline) {
      ready = await evaluate(cdp, 'document.readyState', false).catch(() => '');
      if (ready === 'complete') break;
      await sleep(100);
    }
    if (ready !== 'complete') throw new Error('页面 20s 内未完成加载（readyState=' + ready + '）');

    await cdp.send('Page.bringToFront').catch(() => {});
    log('预热 ' + OPTIONS.settle + ' ms…');
    await sleep(OPTIONS.settle);

    const env = await evaluate(cdp, ENV_EXPRESSION, false);
    log('开始采样 ' + OPTIONS.seconds + ' s…');
    const raw = await evaluate(cdp, measureExpression(OPTIONS.seconds), true,
      Math.max(120000, OPTIONS.seconds * 1000 + 60000));

    const metrics = summarize(raw);

    const warnings = [];
    if (raw.visibilityStart !== 'visible' || raw.visibilityEnd !== 'visible') {
      warnings.push('采样期间页面不可见（visibility=' + raw.visibilityStart + '/' + raw.visibilityEnd +
        '），rAF 可能被节流，FPS 数据不可用。');
    }
    if (!metrics.longTasks.supported) {
      warnings.push('当前浏览器不支持 PerformanceObserver longtask，长任务记为“不支持”。');
    }
    if (!metrics.heap.supported) {
      warnings.push('当前浏览器未暴露 performance.memory，JS 堆记为“不支持”。');
    }
    if (metrics.fps.frames < 2) {
      warnings.push('采样窗口内 rAF 帧数不足 2，FPS 无法计算。');
    }

    result = {
      tool: 'perf-8904',
      version: '1.0.0',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedClock,
      meta: {
        url: OPTIONS.url,
        seconds: OPTIONS.seconds,
        settleMs: OPTIONS.settle,
        cdpPort: OPTIONS.port,
        browser: browser.Browser || null,
        protocolVersion: browser['Protocol-Version'] || null,
        userAgent: browser['User-Agent'] || null,
      },
      env: {
        ...env,
        viewportEnd: raw.viewport,
        dprEnd: raw.dpr,
      },
      load: env.navigation ? {
        domContentLoaded: round(env.navigation.domContentLoaded, 0),
        load: round(env.navigation.load, 0),
        firstPaint: env.paints['first-paint'] ?? null,
        firstContentfulPaint: env.paints['first-contentful-paint'] ?? null,
        transferSize: env.navigation.transferSize,
        encodedBodySize: env.navigation.encodedBodySize,
        decodedBodySize: env.navigation.decodedBodySize,
      } : null,
      metrics,
      warnings,
    };
  } finally {
    if (cdp) cdp.close();
    if (!OPTIONS.keepTab) await closePage(OPTIONS.port, target.id);
  }

  const output = OPTIONS.json
    ? JSON.stringify(result, null, 2) + '\n'
    : humanSummary(result) + '\n' + JSON.stringify(result) + '\n';
  // 显式退出：Chrome 为 detached 子进程，CDP/undici 的长连接可能拖住事件循环
  process.stdout.write(output, () => process.exit(0));
}

main().catch((err) => {
  console.error('[perf-8904] 失败: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
