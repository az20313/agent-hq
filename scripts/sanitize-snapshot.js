/**
 * sanitize-snapshot.js
 * 对 snapshot 做脱敏，避免把内部路径/会话键/runId/任务摘要暴露给浏览器。
 * 用法（库）：import { sanitize } from './sanitize-snapshot.js'
 * 用法（CLI）：node scripts/sanitize-snapshot.js <file...>
 */
import fs from "node:fs";

const DENY_KEYS = new Set([
  "path",
  "workspace",
  "runId",
  "sessionKey",
  "statusReason",
  "sourcePath",
  "dataDir",
]);

export function sanitize(snap) {
  if (!snap || typeof snap !== "object") return snap;

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (DENY_KEYS.has(key)) {
        delete node[key];
        continue;
      }
      walk(node[key]);
    }
  };
  walk(snap);

  // 任务摘要可能包含内部上下文，统一清空但保留字段
  if (Array.isArray(snap.tasks)) {
    for (const t of snap.tasks) {
      if (t && typeof t === "object") t.summary = "";
    }
  }
  return snap;
}

// CLI（仅在直接运行时执行，import 时不跑）
import { pathToFileURL } from "node:url";

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const files = process.argv.slice(2);
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    const clean = sanitize(JSON.parse(raw));
    fs.writeFileSync(f, JSON.stringify(clean), "utf8");
    console.log(`${f}: ${raw.length} -> ${JSON.stringify(clean).length} bytes`);
  }
}
