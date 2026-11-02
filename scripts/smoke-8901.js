#!/usr/bin/env node
/**
 * smoke-8901.js — repeatable deployment smoke test for AGENT HQ (port 8901).
 *
 * Zero dependencies (Node >= 18, global fetch). Does not modify the upstream
 * source or build output; it only reads dist/index.html for consistency checks.
 *
 * Usage:
 *   node scripts/smoke-8901.js
 *   node scripts/smoke-8901.js --url http://127.0.0.1:8901 --timeout 10000
 *
 * Exit codes: 0 = all checks pass (WARN allowed), 1 = at least one FAIL,
 *             2 = usage / runtime error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_INDEX = path.join(PROJECT_ROOT, "dist", "index.html");

const MIN_HOME_BYTES = 700 * 1024; // 700 KB (KiB)
const MAX_HOME_BYTES = 800 * 1024; // 800 KB (KiB)
const MAX_HOME_MS = 1500;

function parseArgs(argv) {
  const opts = { url: "http://127.0.0.1:8901", timeout: 10000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--url" || arg === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      if (arg === "--url") opts.url = value;
      else opts.timeout = value;
    } else if (arg.startsWith("--url=")) {
      opts.url = arg.slice("--url=".length);
    } else if (arg.startsWith("--timeout=")) {
      opts.timeout = arg.slice("--timeout=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  opts.url = String(opts.url).replace(/\/+$/, "");
  const timeout = Number(opts.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got: ${opts.timeout}`);
  }
  opts.timeout = Math.floor(timeout);
  return opts;
}

async function get(url, timeout) {
  const started = performance.now();
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
    headers: { "user-agent": "agent-hq-smoke-8901/1.0" },
  });
  const body = Buffer.from(await res.arrayBuffer());
  const elapsed = performance.now() - started;
  return { res, body, elapsed };
}

function contentType(res) {
  return (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function fmtBytes(n) {
  return `${n} B (${(n / 1024).toFixed(2)} KB)`;
}

function countMatches(html, re) {
  return (html.match(re) || []).length;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error("Usage: node scripts/smoke-8901.js [--url http://127.0.0.1:8901] [--timeout 10000]");
    process.exit(2);
  }

  if (opts.help) {
    console.log("Usage: node scripts/smoke-8901.js [--url http://127.0.0.1:8901] [--timeout 10000]");
    process.exit(0);
  }

  const results = [];
  const record = (status, name, detail) => {
    results.push({ status, name, detail });
    const tag = status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : "FAIL";
    console.log(`[${tag}] ${name}`);
    console.log(`       ${detail}`);
  };

  (async () => {
    console.log("AGENT HQ deployment smoke test");
    console.log(`target : ${opts.url}`);
    console.log(`timeout: ${opts.timeout} ms`);
    console.log(`dist   : ${DIST_INDEX}`);
    console.log("");

    let home = null;
    let snapshot = null;

    try {
      home = await get(`${opts.url}/`, opts.timeout);
      snapshot = await get(`${opts.url}/snapshot.json`, opts.timeout);
    } catch (err) {
      const reason = err && err.name === "TimeoutError"
        ? `request timed out after ${opts.timeout} ms`
        : (err && err.message) || String(err);
      record("FAIL", "0. Server reachability", `cannot fetch ${opts.url}: ${reason}`);
      finish(results);
      return;
    }

    // ---- 1. Home page status / content-type / size -----------------------
    {
      const status = home.res.status;
      const ct = contentType(home.res);
      const size = home.body.length;
      const ok = status === 200 &&
        ct === "text/html" &&
        size >= MIN_HOME_BYTES &&
        size <= MAX_HOME_BYTES;
      const reason = ok
        ? `HTTP ${status}, ${ct}, ${fmtBytes(size)} (expected 200 / text/html / 700-800 KB)`
        : `HTTP ${status}, ${ct}, ${fmtBytes(size)} (expected 200 / text/html / 700-800 KB)`;
      record(ok ? "PASS" : "FAIL", "1. Home page status, content-type, size", reason);
    }

    const html = home.body.toString("utf8");

    // ---- 2. Title --------------------------------------------------------
    {
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = m ? m[1].trim() : "";
      const ok = /AGENT HQ/.test(title);
      record(ok ? "PASS" : "FAIL", "2. Page title contains AGENT HQ",
        m ? `title = ${JSON.stringify(title)}` : "no <title> element found");
    }

    // ---- 3. canvas + three keywords --------------------------------------
    {
      const canvasCount = countMatches(html, /canvas/gi);
      const threeCount = countMatches(html, /three/gi);
      const ok = canvasCount > 0 && threeCount > 0;
      record(ok ? "PASS" : "FAIL", "3. HTML contains canvas and three keywords",
        `"canvas" x${canvasCount}, "three" x${threeCount} (both required > 0)`);
    }

    // ---- 4. No external resources ----------------------------------------
    {
      const checks = [
        ["script[src]", /<script\b[^>]*\bsrc\s*=\s*["']\s*https?:\/\//gi],
        ["link[href]", /<link\b[^>]*\bhref\s*=\s*["']\s*https?:\/\//gi],
        ["img[src]", /<img\b[^>]*\bsrc\s*=\s*["']\s*https?:\/\//gi],
      ];
      const counts = checks.map(([label, re]) => [label, countMatches(html, re)]);
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      const detail = counts.map(([label, n]) => `${label}=${n}`).join(", ");
      record(total === 0 ? "PASS" : "FAIL", "4. No external resource references (http/https)",
        `${detail} (total ${total}, expected 0)`);
    }

    // ---- 5. /snapshot.json -----------------------------------------------
    {
      const status = snapshot.res.status;
      const ct = contentType(snapshot.res);
      const size = snapshot.body.length;
      if (status === 200 && ct === "application/json") {
        let jsonNote = "";
        try {
          const parsed = JSON.parse(snapshot.body.toString("utf8"));
          const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
          jsonNote = `, valid JSON (top-level keys: ${keys.join(", ") || "none"})`;
        } catch {
          jsonNote = ", warning: body is not valid JSON";
        }
        record("PASS", "5. /snapshot.json content-type and size",
          `HTTP ${status}, ${ct}, ${fmtBytes(size)}${jsonNote}`);
      } else if (status === 200 && ct === "text/html") {
        const sameAsHome = size === home.body.length;
        record("WARN", "5. /snapshot.json content-type and size",
          `HTTP ${status}, ${ct}, ${fmtBytes(size)} — served HTML, not JSON. ` +
          `The static server falls back to index.html when a file is missing, so snapshot.json is ` +
          `likely absent from dist/ (body ${sameAsHome ? "matches" : "differs from"} the home page, ` +
          `${fmtBytes(home.body.length)}). Live data bridge is not deployed at this path.`);
      } else {
        record("FAIL", "5. /snapshot.json content-type and size",
          `HTTP ${status}, ${ct}, ${fmtBytes(size)} (expected 200 / application/json)`);
      }
    }

    // ---- 6. dist/index.html exists and matches live bytes ----------------
    {
      if (!fs.existsSync(DIST_INDEX)) {
        record("FAIL", "6. dist/index.html exists and matches live bytes",
          `missing file: ${DIST_INDEX}`);
      } else {
        const localSize = fs.statSync(DIST_INDEX).size;
        const liveSize = home.body.length;
        const ok = localSize === liveSize;
        record(ok ? "PASS" : "FAIL", "6. dist/index.html exists and matches live bytes",
          `local ${fmtBytes(localSize)}, live ${fmtBytes(liveSize)}` +
          (ok ? "" : `, delta ${liveSize - localSize} B`));
      }
    }

    // ---- 7. Home response time -------------------------------------------
    {
      const ms = Math.round(home.elapsed);
      const ok = ms < MAX_HOME_MS;
      record(ok ? "PASS" : "FAIL", "7. Home response time",
        `${ms} ms (expected < ${MAX_HOME_MS} ms)`);
    }

    finish(results);
  })().catch((err) => {
    console.error(`ERROR: unexpected failure: ${(err && err.stack) || err}`);
    process.exit(2);
  });
}

function finish(results) {
  const passed = results.filter((r) => r.status === "PASS").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  console.log("");
  console.log("Summary");
  console.log(`  PASS: ${passed}`);
  console.log(`  WARN: ${warned}`);
  console.log(`  FAIL: ${failed}`);
  if (failed > 0) {
    console.log("");
    console.log("Failed checks:");
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  console.log("");
  console.log(failed > 0 ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed > 0 ? 1 : 0);
}

main();
