// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
// Check that a running backend supports every node type and port used by a
// workflow JSON file. This catches the common "frontend/demo is newer than the
// running backend binary" failure mode before workflow.execute cascades into
// dangling-edge errors.
//
// Usage:
//   node scripts/check_backend_capabilities.mjs demo/NCNN_demo/image_classification.json
//   PORT=9090 node scripts/check_backend_capabilities.mjs path/to/workflow.json
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const workflowArg =
  process.argv[2] ?? "demo/NCNN_demo/image_classification.json";
const WORKFLOW = path.isAbsolute(workflowArg)
  ? workflowArg
  : path.join(REPO_ROOT, workflowArg);
const PORT = process.env.PORT ?? 9090;

function fail(message) {
  console.error(`[capability-check] FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(WORKFLOW)) {
  fail(`workflow not found: ${WORKFLOW}`);
}

const workflow = JSON.parse(fs.readFileSync(WORKFLOW, "utf8"));
const ws = new WebSocket(`ws://localhost:${PORT}`);
let timeout;

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "nodes.list",
      params: {},
    }),
  );
  timeout = setTimeout(
    () => fail(`timeout waiting for nodes.list on port ${PORT}`),
    5000,
  );
});

ws.addEventListener("message", (event) => {
  clearTimeout(timeout);
  const response = JSON.parse(event.data.toString());
  if (response.error) {
    fail(`nodes.list rejected: ${JSON.stringify(response.error)}`);
  }
  const backendNodes = response.result?.nodes;
  if (!Array.isArray(backendNodes)) {
    fail(
      `nodes.list returned unexpected payload: ${JSON.stringify(response.result)}`,
    );
  }

  const byType = new Map(backendNodes.map((node) => [node.type, node]));
  const errors = [];

  for (const node of workflow.nodes ?? []) {
    if (!byType.has(node.type)) {
      errors.push(`Unknown node type '${node.type}' used by node '${node.id}'`);
    }
  }

  for (const edge of workflow.edges ?? []) {
    const source = workflow.nodes.find((node) => node.id === edge.source);
    const target = workflow.nodes.find((node) => node.id === edge.target);
    if (!source || !target) continue;

    const sourceDef = byType.get(source.type);
    const targetDef = byType.get(target.type);
    const sourcePorts = new Set(
      (sourceDef?.ports ?? []).map((port) => `${port.direction}:${port.id}`),
    );
    const targetPorts = new Set(
      (targetDef?.ports ?? []).map((port) => `${port.direction}:${port.id}`),
    );

    if (sourceDef && !sourcePorts.has(`source:${edge.sourceHandle}`)) {
      errors.push(
        `Node '${source.id}' (${source.type}) has no source port '${edge.sourceHandle}' required by edge '${edge.id}'`,
      );
    }
    if (targetDef && !targetPorts.has(`target:${edge.targetHandle}`)) {
      errors.push(
        `Node '${target.id}' (${target.type}) has no target port '${edge.targetHandle}' required by edge '${edge.id}'`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(
      `[capability-check] Backend on port ${PORT} is missing workflow capabilities:`,
    );
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      "[capability-check] Rebuild and restart the backend binary, e.g.:",
    );
    console.error("  cmake --build backend/build --parallel");
    console.error("  backend/build/workflow_backend --port 9090");
    process.exit(1);
  }

  console.log(
    `[capability-check] OK: backend on port ${PORT} supports ${workflow.nodes.length} workflow nodes and ${workflow.edges.length} edges`,
  );
  ws.close();
});

ws.addEventListener("error", (event) => {
  fail(`socket error on port ${PORT}: ${event.message ?? "unknown error"}`);
});
