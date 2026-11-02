#!/usr/bin/env node
/**
 * e2e-live.js — AGENT HQ 真实数据端到端验证（可重跑，零 npm 依赖）
 *
 * 验证内容
 *   1) 打开页面并等待 6–8s，确认 HTTP 200 且 DOM 就绪
 *   2) <html data-source> === "live"（不是 mock / null）
 *   3) 页面文本包含 /snapshot.json 的第一条任务标题
 *   4) <canvas> 存在，且页面没有 JS 异常（Runtime.exceptionThrown）
 *   5) --poll-test：备份 → kpis.done + 1 → 等待轮询生效 → 无论成败恢复并校验 SHA256
 *   6) PASS/FAIL 汇总与退出码
 *
 * 依赖：Node >= 22（内置 fetch / WebSocket / AbortSignal.timeout）。
 * CDP 协议层由本脚本自行实现，不依赖 puppeteer / playwright。
 *
 * 用法
 *   node scripts/e2e-live.js
 *   node scripts/e2e-live.js --url http://127.0.0.1:8904/ --poll-test \
 *     --snapshot D:\path\to\dist\snapshot.json
 *   node scripts/e2e-live.js --cdp http://127.0.0.1:9222      # 复用已开的 Chrome
 *
 * 参数
 *   --url <url>         页面地址，默认 http://127.0.0.1:8904/
 *   --settle <ms>       页面加载后的等待时间，默认 7000（限制在 6000–8000）
 *   --poll-test         开启快照轮询验证（会临时改写 --snapshot 文件）
 *   --poll-wait <ms>    等待页面轮询生效的时间，默认 35000
 *   --snapshot <path>   被改写的快照文件，默认 <repo>/dist/snapshot.json
 *   --cdp <http-base>   连接已有 Chrome 的调试端口，例如 http://127.0.0.1:9222
 *   --chrome <path>     指定 Chrome/Edge 可执行文件（默认自动探测）
 *   --help
 *
 * 退出码：0 = 全部通过（允许 SKIP），1 = 至少一项 FAIL，2 = 运行/参数错误。
 *
 * 边界：只在 --poll-test 时改写 --snapshot 指向的单个文件；不重启服务、
 *       不改 src/、不删除任何业务文件。恢复失败时以 FAIL 结束。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_SNAPSHOT = path.join(PROJECT_ROOT, "dist", "snapshot.json");

const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1);

function log(...args) {
  console.log(`[e2e ${elapsed().padStart(5)}s]`, ...args);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function normalizeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function shortHash(h) {
  return h ? `${h.slice(0, 12)}…${h.slice(-8)}` : "(none)";
}

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    url: "http://127.0.0.1:8904/",
    settle: 7000,
    pollTest: false,
    pollWait: 35000,
    snapshot: DEFAULT_SNAPSHOT,
    cdp: null,
    chrome: null,
    help: false,
  };

  const need = (name, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} 需要一个值`);
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];

    switch (key) {
      case "--url":
        opts.url = inline ?? need("--url", i);
        if (inline === null) i += 1;
        break;
      case "--settle":
        opts.settle = Number(inline ?? need("--settle", i));
        if (inline === null) i += 1;
        break;
      case "--poll-test":
        opts.pollTest = true;
        break;
      case "--poll-wait":
        opts.pollWait = Number(inline ?? need("--poll-wait", i));
        if (inline === null) i += 1;
        break;
      case "--snapshot":
        opts.snapshot = inline ?? need("--snapshot", i);
        if (inline === null) i += 1;
        break;
      case "--cdp":
        opts.cdp = inline ?? need("--cdp", i);
        if (inline === null) i += 1;
        break;
      case "--chrome":
        opts.chrome = inline ?? need("--chrome", i);
        if (inline === null) i += 1;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!/^https?:\/\//i.test(opts.url)) throw new Error(`--url 必须是 http(s) 地址: ${opts.url}`);
  opts.url = opts.url.replace(/\/+$/, "") + "/";

  if (!Number.isFinite(opts.settle) || opts.settle <= 0) {
    throw new Error(`--settle 必须是正数，收到: ${opts.settle}`);
  }
  if (opts.settle < 6000 || opts.settle > 8000) {
    const clamped = Math.min(8000, Math.max(6000, Math.round(opts.settle)));
    log(`--settle=${opts.settle}ms 超出 6–8s 约定，按 ${clamped}ms 执行`);
    opts.settle = clamped;
  }

  if (!Number.isFinite(opts.pollWait) || opts.pollWait < 1000) {
    throw new Error(`--poll-wait 必须 >= 1000ms，收到: ${opts.pollWait}`);
  }

  opts.snapshot = path.resolve(opts.snapshot);
  if (opts.cdp) opts.cdp = opts.cdp.replace(/\/+$/, "");

  return opts;
}

function printHelp() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0];
  console.log(header.replace(/^#!.*\n/, ""));
}

/* ------------------------------------------------------------- 文件工具 */

/** 同目录临时文件 + rename，避免静态服务器读到半个 JSON。 */
function atomicWriteSync(file, buf) {
  const tmp = `${file}.e2e-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/* ---------------------------------------------------------- 快照恢复状态 */

/**
 * 恢复上下文是全局的，保证 Ctrl+C / 异常退出也能把文件写回原样。
 * done=true 后重复调用只返回之前的校验结果。
 */
let restoreCtx = null;

function restoreSnapshotSync() {
  const ctx = restoreCtx;
  if (!ctx) return null;
  if (ctx.done) return ctx.hashMatch;

  try {
    if (ctx.tmpPath) {
      try {
        fs.unlinkSync(ctx.tmpPath);
      } catch {
        /* 已被 rename 消费或不存在 */
      }
      ctx.tmpPath = null;
    }
    // 无论是否成功改写，都用原始备份覆盖一次，确保字节级还原。
    atomicWriteSync(ctx.path, ctx.backup);
    const after = sha256(fs.readFileSync(ctx.path));
    ctx.afterHash = after;
    ctx.hashMatch = after === ctx.beforeHash;
  } catch (err) {
    ctx.error = err;
    ctx.hashMatch = false;
  } finally {
    ctx.done = true;
  }
  return ctx.hashMatch;
}

/* ------------------------------------------------------------- CDP 客户端 */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener("message", (ev) => this._onMessage(ev));
    ws.addEventListener("close", () => this._onClose());
  }

  static connect(wsUrl, timeoutMs = 15000) {
    if (typeof WebSocket !== "function") {
      return Promise.reject(new Error("当前 Node 没有内置 WebSocket（需要 Node >= 22）"));
    }
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      return Promise.reject(err);
    }
    const client = new CDP(ws);
    return client._ready(timeoutMs).then(() => client);
  }

  _ready(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`连接 CDP 超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.ws.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        "error",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("CDP WebSocket 连接失败"));
        },
        { once: true },
      );
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`${msg.error.message || "CDP error"} (code ${msg.error.code ?? "?"})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      try {
        entry.fn(msg.params);
      } catch {
        /* 事件处理不应打断协议层 */
      }
    }
  }

  _onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP 连接已关闭"));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`CDP 连接已关闭，无法调用 ${method}`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（${timeoutMs}ms）: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 等待一次事件；超时 resolve(null)，避免因缺事件卡死整个测试。 */
  once(method, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const set = this.handlers.get(method) ?? new Set();
      this.handlers.set(method, set);

      const entry = {
        once: true,
        fn: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      };

      const timer = setTimeout(() => {
        set.delete(entry);
        resolve(null);
      }, timeoutMs);

      set.add(entry);
    });
  }

  on(method, fn) {
    const set = this.handlers.get(method) ?? new Set();
    this.handlers.set(method, set);
    const entry = { once: false, fn };
    set.add(entry);
    return () => set.delete(entry);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function describeException(details) {
  const ex = details?.exception;
  const text = ex?.description || ex?.value || details?.text || "(unknown)";
  const where = details?.url || "(inline)";
  const line = details?.lineNumber ?? "?";
  const col = details?.columnNumber ?? "?";
  return `${String(text).split("\n")[0].slice(0, 300)} @ ${where}:${line}:${col}`;
}

async function evaluate(client, expression, timeoutMs = 30000) {
  const res = await client.send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      includeCommandLineAPI: false,
    },
    timeoutMs,
  );
  if (res.exceptionDetails) {
    throw new Error(`页面求值异常: ${describeException(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

/* ------------------------------------------------------------- Chrome 控制 */

function findBrowser(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--chrome 指向的文件不存在: ${explicit}`);
    return explicit;
  }

  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdpHttp(base, timeoutMs, childInfo) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    if (childInfo && childInfo.child.exitCode !== null) {
      throw new Error(
        `Chrome 提前退出（code ${childInfo.child.exitCode}）\n${childInfo.stderr().slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const info = await res.json();
        return info;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }

  throw new Error(`等待 CDP 端口超时: ${base}（${lastErr?.message || "无响应"}）`);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

async function launchChrome(browserPath) {
  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hq-e2e-"));
  const base = `http://127.0.0.1:${port}`;

  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--disable-dev-shm-usage",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=1600,1000",
    // 无 GPU 环境用 SwiftShader 保证 WebGL canvas 能创建
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ];

  log(`启动无头浏览器: ${browserPath}`);
  const child = spawn(browserPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderrBuf = "";
  child.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  const info = {
    child,
    port,
    base,
    userDataDir,
    stderr: () => stderrBuf,
  };

  try {
    const version = await waitForCdpHttp(base, 25000, info);
    log(`Chrome 已就绪: ${version.Browser || "unknown"} (CDP ${base})`);
    return info;
  } catch (err) {
    killTree(child);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function createTarget(base) {
  let res = await fetch(`${base}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    res = await fetch(`${base}/json/new?${encodeURIComponent("about:blank")}`, {
      signal: AbortSignal.timeout(10000),
    });
  }
  if (!res.ok) throw new Error(`新建标签页失败: HTTP ${res.status}`);
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) throw new Error("新建标签页未返回 webSocketDebuggerUrl");
  return target;
}

async function closeTarget(base, targetId) {
  if (!targetId) return;
  try {
    await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- 检查项 */

const checks = new Map();

function record(id, label, status, detail = "") {
  checks.set(id, { label, status, detail });
}

function summarize() {
  console.log("\n=== E2E LIVE RESULT ===");
  for (let id = 1; id <= 6; id += 1) {
    const c = checks.get(id);
    if (!c) continue;
    console.log(`[${id}] ${c.label.padEnd(40, " ")} ${c.status}${c.detail ? `  ${c.detail}` : ""}`);
  }

  const values = [...checks.values()];
  const failed = values.filter((c) => c.status === "FAIL");
  const passed = values.filter((c) => c.status === "PASS");
  const skipped = values.filter((c) => c.status === "SKIP");

  console.log(
    `\nSUMMARY: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
      `  (${elapsed()}s)`,
  );
  console.log(`RESULT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  return failed.length === 0;
}

/* ------------------------------------------------------------ 轮询验证 */

async function runPollTest(client, opts) {
  const snapshotPath = opts.snapshot;
  const kpiExpr = `(() => {
    const el = document.querySelector('.hud-left .kpi-block') || document.querySelector('.hud-left');
    return el ? el.innerText : '';
  })()`;

  if (!fs.existsSync(snapshotPath)) {
    record(5, "轮询验证（KPI 跟随 snapshot 更新）", "FAIL", `快照不存在: ${snapshotPath}`);
    record(6, "快照恢复 + SHA256 校验", "SKIP", "未发生改写");
    return;
  }

  const backup = fs.readFileSync(snapshotPath);
  const beforeHash = sha256(backup);

  restoreCtx = {
    path: snapshotPath,
    backup,
    beforeHash,
    afterHash: null,
    hashMatch: null,
    done: false,
    tmpPath: null,
    error: null,
  };

  log(`快照已备份: ${snapshotPath}  sha256=${shortHash(beforeHash)}`);

  let beforeText = "";
  let changeMs = null;

  try {
    beforeText = normalizeText(await evaluate(client, kpiExpr));

    const raw = backup.toString("utf8").replace(/^\uFEFF/, "");
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object" || !snap.kpis || typeof snap.kpis.done !== "number") {
      throw new Error("快照缺少数值型 kpis.done，无法执行 +1");
    }

    const originalDone = snap.kpis.done;
    const expectedDone = originalDone + 1;
    snap.kpis.done = expectedDone;

    const payload = Buffer.from(JSON.stringify(snap, null, 2) + "\n", "utf8");
    restoreCtx.tmpPath = `${snapshotPath}.e2e-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(restoreCtx.tmpPath, payload);
    fs.renameSync(restoreCtx.tmpPath, snapshotPath);
    restoreCtx.tmpPath = null;

    log(`已改写 kpis.done: ${originalDone} -> ${expectedDone}，等待页面轮询（最多 ${opts.pollWait}ms）…`);

    const started = Date.now();
    const deadline = started + opts.pollWait;
    let afterText = beforeText;
    let changed = false;

    while (Date.now() < deadline) {
      await sleep(1000);
      afterText = normalizeText(await evaluate(client, kpiExpr));
      if (afterText !== beforeText) {
        changed = true;
        changeMs = Date.now() - started;
        break;
      }
    }

    const doneMatch = /DONE\s+([\d,]+)/.exec(afterText);
    const shownDone = doneMatch ? Number(doneMatch[1].replace(/,/g, "")) : null;
    const doneOk = shownDone === null ? null : shownDone === expectedDone;

    if (changed && doneOk !== false) {
      record(
        5,
        "轮询验证（KPI 跟随 snapshot 更新）",
        "PASS",
        `done ${originalDone}->${expectedDone} 在 ${(changeMs / 1000).toFixed(1)}s 后上屏` +
          (shownDone === null ? "（未解析到 DONE 数字，仅按文本变化判定）" : `，页面 DONE=${shownDone}`),
      );
    } else if (!changed) {
      record(
        5,
        "轮询验证（KPI 跟随 snapshot 更新）",
        "FAIL",
        `${(opts.pollWait / 1000).toFixed(1)}s 内 KPI 文本未变化`,
      );
    } else {
      record(
        5,
        "轮询验证（KPI 跟随 snapshot 更新）",
        "FAIL",
        `文本已变化但页面 DONE=${shownDone}，期望 ${expectedDone}`,
      );
    }
  } catch (err) {
    record(5, "轮询验证（KPI 跟随 snapshot 更新）", "FAIL", String(err.message || err));
  } finally {
    // 关键：无论上面成功与否，都必须恢复原文件。
    const ok = restoreSnapshotSync();
    const ctx = restoreCtx;
    const detail = ok
      ? `已恢复，SHA256=${shortHash(ctx.afterHash)} 与备份一致`
      : `恢复失败或不一致：${ctx.error ? ctx.error.message : `after=${shortHash(ctx.afterHash)} before=${shortHash(ctx.beforeHash)}`}`;
    record(6, "快照恢复 + SHA256 校验", ok ? "PASS" : "FAIL", detail);
    log(detail);
  }
}

/* ------------------------------------------------------------------ 主流程 */

let chromeInfo = null;
let cdp = null;
let target = null;

function cleanup() {
  // 先恢复文件（幂等），再关浏览器，避免中途被打断留下脏数据。
  try {
    restoreSnapshotSync();
  } catch {
    /* ignore */
  }
  if (cdp) {
    cdp.close();
    cdp = null;
  }
  if (chromeInfo) {
    if (chromeInfo.base && target?.id) {
      // 关闭标签页是异步的，退出前不等待；进程随后会被杀掉
      void closeTarget(chromeInfo.base, target.id);
    }
    killTree(chromeInfo.child);
    try {
      fs.rmSync(chromeInfo.userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } catch {
      /* ignore */
    }
    chromeInfo = null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.error(`\n收到 ${sig}，正在恢复现场…`);
      cleanup();
      process.exit(130);
    });
  }

  const url = opts.url;
  log(`目标页面: ${url}`);
  log(`等待时间: ${opts.settle}ms；轮询测试: ${opts.pollTest ? "开启" : "关闭"}`);
  if (opts.pollTest) log(`快照文件: ${opts.snapshot}`);

  // ---- 1. HTTP 可达性
  let pageRes;
  try {
    pageRes = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": "agent-hq-e2e-live/1.0" },
    });
  } catch (err) {
    record(1, "页面可访问（HTTP 200 + DOM 就绪）", "FAIL", `请求失败: ${err.message}`);
    return summarize() ? 0 : 1;
  }

  if (!pageRes.ok) {
    record(1, "页面可访问（HTTP 200 + DOM 就绪）", "FAIL", `HTTP ${pageRes.status}`);
    return summarize() ? 0 : 1;
  }

  // ---- 启动 / 连接浏览器
  try {
    if (opts.cdp) {
      log(`连接已有 Chrome: ${opts.cdp}`);
      chromeInfo = { base: opts.cdp, child: null, userDataDir: null, stderr: () => "" };
      await waitForCdpHttp(opts.cdp, 8000, null);
    } else {
      const browser = findBrowser(opts.chrome);
      if (!browser) {
        throw new Error("未找到 Chrome/Edge，请用 --chrome 指定可执行文件，或用 --cdp 连接调试端口");
      }
      chromeInfo = await launchChrome(browser);
    }

    target = await createTarget(chromeInfo.base);
    cdp = await CDP.connect(target.webSocketDebuggerUrl, 15000);
  } catch (err) {
    record(1, "页面可访问（HTTP 200 + DOM 就绪）", "FAIL", `浏览器/CDP 启动失败: ${err.message}`);
    cleanup();
    return summarize() ? 0 : 1;
  }

  // ---- 2. 开启域、收集异常
  const exceptions = [];
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    cdp.on("Runtime.exceptionThrown", (params) => {
      const item = describeException(params?.exceptionDetails);
      exceptions.push(item);
      log(`捕获 JS 异常: ${item}`);
    });
  } catch (err) {
    record(1, "页面可访问（HTTP 200 + DOM 就绪）", "FAIL", `CDP 初始化失败: ${err.message}`);
    cleanup();
    return summarize() ? 0 : 1;
  }

  // ---- 导航并等待 6–8s
  try {
    const loadEvent = cdp.once("Page.loadEventFired", 25000);
    const nav = await cdp.send("Page.navigate", { url }, 25000);
    if (nav?.errorText) throw new Error(`导航失败: ${nav.errorText}`);
    await loadEvent;
    await cdp.send("Page.bringToFront").catch(() => {});

    const readyState = await evaluate(cdp, "document.readyState").catch(() => "unknown");
    log(`DOM ${readyState}，等待 ${opts.settle}ms 让真实快照与 WebGL 场景完成…`);
    await sleep(opts.settle);

    const state = await evaluate(
      cdp,
      `(() => ({ readyState: document.readyState, visibility: document.visibilityState }))()`,
    );
    const ok = state && (state.readyState === "complete" || state.readyState === "interactive");
    record(
      1,
      "页面可访问（HTTP 200 + DOM 就绪）",
      ok ? "PASS" : "FAIL",
      `HTTP ${pageRes.status}，readyState=${state?.readyState ?? "?"}，visibility=${state?.visibility ?? "?"}，等待 ${opts.settle}ms`,
    );
  } catch (err) {
    record(1, "页面可访问（HTTP 200 + DOM 就绪）", "FAIL", String(err.message || err));
  }

  // ---- 3. data-source === live
  try {
    const source = await evaluate(cdp, "document.documentElement.getAttribute('data-source')");
    record(
      2,
      "<html data-source> === live",
      source === "live" ? "PASS" : "FAIL",
      `data-source=${JSON.stringify(source)}`,
    );
  } catch (err) {
    record(2, "<html data-source> === live", "FAIL", String(err.message || err));
  }

  // ---- 4. 真实任务标题
  let firstTitle = null;
  try {
    const snapUrl = new URL("snapshot.json", url).href + `?e2e=${Date.now()}`;
    const res = await fetch(snapUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": "agent-hq-e2e-live/1.0" },
    });
    if (!res.ok) throw new Error(`GET /snapshot.json -> HTTP ${res.status}`);
    const snap = await res.json();
    if (!Array.isArray(snap.tasks) || snap.tasks.length === 0) {
      throw new Error("snapshot.tasks 为空，无法取得对照标题");
    }
    firstTitle = normalizeText(snap.tasks[0]?.title);
    if (!firstTitle) throw new Error("第一条任务标题为空");

    const pageText = normalizeText(await evaluate(cdp, "document.body ? document.body.innerText : ''"));
    const found = pageText.includes(firstTitle);
    record(
      3,
      "页面包含真实任务标题",
      found ? "PASS" : "FAIL",
      found ? `已找到「${firstTitle}」` : `页面文本未找到「${firstTitle}」`,
    );
  } catch (err) {
    record(3, "页面包含真实任务标题", "FAIL", String(err.message || err));
  }

  // ---- 5+6. 快照轮询验证（含恢复）
  if (opts.pollTest) {
    await runPollTest(cdp, opts);
  } else {
    record(5, "轮询验证（KPI 跟随 snapshot 更新）", "SKIP", "未指定 --poll-test");
    record(6, "快照恢复 + SHA256 校验", "SKIP", "未发生改写");
  }

  // ---- 4. canvas + JS 异常（最后统计，确保捕获到轮询期间的异常）
  try {
    const canvasInfo = await evaluate(
      cdp,
      `(() => {
        const list = [...document.querySelectorAll('canvas')];
        return {
          count: list.length,
          sizes: list.slice(0, 3).map((c) => [c.width, c.height]),
        };
      })()`,
    );
    const count = canvasInfo?.count ?? 0;
    const canvasOk = count >= 1;
    const noExceptions = exceptions.length === 0;
    const status = canvasOk && noExceptions ? "PASS" : "FAIL";

    let detail = `canvas=${count}（尺寸 ${JSON.stringify(canvasInfo?.sizes ?? [])}），JS 异常=${exceptions.length}`;
    if (!noExceptions) detail += `；首条: ${exceptions[0]}`;
    record(4, "canvas 存在且无 JS 异常", status, detail);
  } catch (err) {
    record(4, "canvas 存在且无 JS 异常", "FAIL", String(err.message || err));
  }

  cleanup();
  return summarize() ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\n[E2E ERROR] ${err?.stack || err}`);
    cleanup();
    process.exitCode = 2;
  });
