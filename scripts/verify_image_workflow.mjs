// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
// Verification harness: load a demo workflow JSON, send it to a running
// backend, check every node ends in {done, skipped} and that
// workflow.complete arrives. Exits 0 on success, non-zero on failure.
// Uses Node's built-in WebSocket (>= Node 22). No extra deps required.
//
// Usage:
//   node scripts/verify_image_workflow.mjs                       # default workflow
//   node scripts/verify_image_workflow.mjs path/to/workflow.json # custom workflow
//   PORT=9090 node scripts/verify_image_workflow.mjs             # custom port
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WORKFLOW = "demo/image_processing/workflow.json";
const argPath = process.argv[2];
const WORKFLOW = argPath
  ? path.isAbsolute(argPath)
    ? argPath
    : path.join(REPO_ROOT, argPath)
  : path.join(REPO_ROOT, DEFAULT_WORKFLOW);
const PORT = process.env.PORT ?? 9097;
console.log(
  `[verify] workflow=${path.relative(REPO_ROOT, WORKFLOW)} port=${PORT}`,
);

const wf = JSON.parse(fs.readFileSync(WORKFLOW, "utf8"));

// Compute expected condition-routing assertions dynamically from the graph:
// every reachable descendant of a true_branch / false_branch edge.
function descendants(startIds, edges) {
  const out = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of edges) {
      if (e.source === cur && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}
const conditionNodes = wf.nodes.filter((n) => n.type === "condition");
const branchTargets = conditionNodes.flatMap((c) => {
  const trueRoots = wf.edges
    .filter((e) => e.source === c.id && e.sourceHandle === "true_branch")
    .map((e) => e.target);
  const falseRoots = wf.edges
    .filter((e) => e.source === c.id && e.sourceHandle === "false_branch")
    .map((e) => e.target);
  return [
    {
      true: [...trueRoots, ...descendants(trueRoots, wf.edges)],
      false: [...falseRoots, ...descendants(falseRoots, wf.edges)],
    },
  ];
});

const ws = new WebSocket(`ws://localhost:${PORT}`);
const status = {};
let completed = false;
let timeoutHandle;

function fail(msg) {
  console.error(`[verify] FAIL: ${msg}`);
  console.error(`[verify] statuses: ${JSON.stringify(status, null, 2)}`);
  process.exit(1);
}

ws.addEventListener("open", () => {
  const nodes = wf.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    config: n.data?.config ?? {},
  }));
  const edges = wf.edges.map((e) => ({
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
  }));
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "workflow.execute",
      params: { nodes, edges },
    }),
  );
  timeoutHandle = setTimeout(() => fail("timeout after 30s"), 30000);
});

ws.addEventListener("message", (event) => {
  const m = JSON.parse(event.data.toString());
  if (m.method === "node.status") {
    const { node_id, status: s, error } = m.params;
    if (node_id !== "__workflow__") {
      status[node_id] = s;
      if (s === "error") fail(`node ${node_id} errored: ${error}`);
      console.log(`  ${node_id.padEnd(12)} -> ${s}${error ? " " + error : ""}`);
    }
  } else if (m.method === "workflow.complete") {
    completed = true;
    clearTimeout(timeoutHandle);
    ws.close();
  } else if (m.id === 1 && m.error) {
    fail(`workflow.execute rejected: ${JSON.stringify(m.error)}`);
  }
});

ws.addEventListener("close", () => {
  if (!completed) fail("socket closed before workflow.complete");
  // Verify every node landed somewhere terminal.
  for (const n of wf.nodes) {
    if (!["done", "skipped"].includes(status[n.id])) {
      fail(`node ${n.id} ended in '${status[n.id]}'`);
    }
  }
  // Verify each condition node routed exactly one branch.
  for (const branch of branchTargets) {
    if (branch.true.length === 0 && branch.false.length === 0) continue;
    const trueDone = branch.true.every((id) => status[id] === "done");
    const falseDone = branch.false.every((id) => status[id] === "done");
    const trueSkipped = branch.true.every((id) => status[id] === "skipped");
    const falseSkipped = branch.false.every((id) => status[id] === "skipped");
    const tookTrue = trueDone && (branch.false.length === 0 || falseSkipped);
    const tookFalse = falseDone && (branch.true.length === 0 || trueSkipped);
    if (!tookTrue && !tookFalse) {
      fail(
        `condition did not route exactly one branch: true=${JSON.stringify(branch.true)} false=${JSON.stringify(branch.false)}`,
      );
    }
  }
  console.log("[verify] OK — workflow.complete received, all nodes terminal");
  process.exit(0);
});

ws.addEventListener("error", (e) =>
  fail(`socket error: ${e.message ?? "unknown"}`),
);
