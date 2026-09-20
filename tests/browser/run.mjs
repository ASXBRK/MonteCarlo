#!/usr/bin/env node
// Browser test orchestrator (docs/specs/40-browser-test-harness.md,
// Commit 1) — builds, serves the BUILT output (`vite preview`, not the
// dev server, so this tests what ships), waits for it to actually
// answer, runs every tests/browser/*.test.mjs file under node:test,
// then tears the preview server down regardless of outcome and exits
// with the test run's own code. `npm run test:browser` is this file.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { PREVIEW_PORT } from "./support.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The local binary directly, not `npx vite` — npx spawns vite as its
// OWN child, so killing the npx process (what preview.kill() below
// would otherwise target) doesn't kill the actual vite server
// underneath it. Confirmed directly while building this harness: the
// preview process survived every teardown attempt, silently holding
// the port (and this script's own process) open for minutes after the
// tests themselves had already finished in under ten seconds.
const viteBin = path.join(rootDir, "node_modules/.bin/vite");

// Every spawned child, tracked so the watchdog (below) can SIGKILL them
// directly on a hang. The npx-orphan bug above was one way a child
// outlives this script; a child that hangs on its own (network stall,
// or — found while building Commit 2 — a test that clicks a real
// "Run Monte Carlo" button and waits out the whole simulation instead
// of just checking it started) is another. Without this, the watchdog's
// process.exit() below kills only this process: the test child (and
// the preview server it's talking to) keep running, orphaned, forever
// — exactly what was observed: `node --test` and `vite preview` both
// still alive and burning CPU minutes after this script's own process
// had already exited.
const liveChildren = new Set();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: rootDir, stdio: "inherit", ...opts });
    liveChildren.add(child);
    child.on("exit", (code) => {
      liveChildren.delete(child);
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Preview server never answered at ${url} within ${timeoutMs}ms`);
}

async function main() {
  console.log("[test:browser] building…");
  await run(viteBin, ["build"]);

  console.log(`[test:browser] starting preview on :${PREVIEW_PORT}…`);
  const preview = spawn(viteBin, ["preview", "--port", String(PREVIEW_PORT), "--strictPort"], {
    cwd: rootDir, stdio: "inherit",
  });
  liveChildren.add(preview);
  let previewExited = false;
  preview.on("exit", () => { previewExited = true; liveChildren.delete(preview); });

  const stopPreview = () => {
    if (!previewExited && !preview.killed) preview.kill("SIGKILL");
  };

  try {
    await waitForServer(`http://localhost:${PREVIEW_PORT}`);

    const testFiles = globSync("tests/browser/*.test.mjs", { cwd: rootDir });
    if (testFiles.length === 0) throw new Error("No tests/browser/*.test.mjs files found.");
    console.log(`[test:browser] running ${testFiles.length} suite file(s): ${testFiles.join(", ")}`);
    await run("node", ["--test", ...testFiles]);
    console.log("[test:browser] PASSED");
  } finally {
    stopPreview();
  }
}

// A hard watchdog, independent of every timeout above: "keep it fast"
// (the spec's own words — a suite that stops being run is worse than
// none) is a promise this script keeps by construction, not by hoping
// every phase's own timeout fires correctly. Comfortably under the
// spec's "a couple of minutes" budget so a genuine hang is reported
// loudly and promptly rather than left to whatever calls this script
// to eventually notice.
const watchdog = setTimeout(() => {
  console.error("[test:browser] FAILED: exceeded 110s overall — killing the run rather than hanging.");
  // process.exit() only ends THIS process — every still-running child
  // (the preview server, or a test runner stuck on a control that
  // triggered real background work) is orphaned by it, not stopped.
  // SIGKILL each one directly first, exactly the class of bug the
  // npx-vite fix above closed for the ordinary exit path.
  for (const child of liveChildren) {
    if (!child.killed) child.kill("SIGKILL");
  }
  process.exit(1);
}, 110_000);
watchdog.unref();

main()
  .catch((err) => {
    console.error("[test:browser] FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
