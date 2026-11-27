import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeploymentRecord,
  getDeploymentById,
  getProjectById,
  updateDeployment,
} from "./db";
import {
  type Deployment,
  type DeploymentStatus,
  type Project,
  type ShellType,
  type TriggerType,
  generateSecret,
  parseEnvVars,
} from "./types";
import { createLogRedactor } from "./security";

export interface DeploymentStreamEvent {
  type: "log" | "status" | "done";
  deploymentId: string;
  chunk?: string;
  status?: DeploymentStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  finishedAt?: string | null;
}

export interface GlobalEvent {
  type:
    | "deployment_created"
    | "deployment_updated"
    | "project_created"
    | "project_updated"
    | "project_deleted";
  projectId?: string;
  deploymentId?: string;
  status?: DeploymentStatus;
  buildNumber?: number;
  timestamp: string;
}

type StreamListener = (event: DeploymentStreamEvent) => void;
type GlobalListener = (event: GlobalEvent) => void;

const MAX_LOG_CHARS = 500_000;
export const MAX_QUEUE_PER_PROJECT = 5;

const deploymentListeners = new Map<string, Set<StreamListener>>();
const globalListeners = new Set<GlobalListener>();
const activeLogs = new Map<string, string>();
const activeProcs = new Map<string, Bun.Subprocess>();
const cancelledDeployments = new Set<string>();
const projectQueues = new Map<string, string[]>();
const runningProjects = new Set<string>();

export function emitGlobalEvent(event: Omit<GlobalEvent, "timestamp">): void {
  const payload: GlobalEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  for (const listener of globalListeners) {
    try {
      listener(payload);
    } catch {
      // Ignore broken client stream
    }
  }
}

export function subscribeGlobal(listener: GlobalListener): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function subscribeDeployment(
  deploymentId: string,
  listener: StreamListener
): () => void {
  let set = deploymentListeners.get(deploymentId);
  if (!set) {
    set = new Set();
    deploymentListeners.set(deploymentId, set);
  }
  set.add(listener);
  return () => {
    const current = deploymentListeners.get(deploymentId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      deploymentListeners.delete(deploymentId);
    }
  };
}

function emitStream(event: DeploymentStreamEvent): void {
  const listeners = deploymentListeners.get(event.deploymentId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore closed stream
    }
  }
}

export function getLiveLogs(deploymentId: string): string | null {
  return activeLogs.get(deploymentId) ?? null;
}

export function parseCommandSteps(commands: string): string[] {
  const lines = commands.split(/\r?\n/);
  const steps: string[] = [];
  let buffer = "";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!buffer && (!trimmed || trimmed.startsWith("#"))) {
      continue;
    }

    if (trimmed.endsWith("\\") && !trimmed.endsWith("\\\\")) {
      buffer += (buffer ? " " : "") + trimmed.slice(0, -1).trim();
    } else {
      const full = buffer ? `${buffer} ${trimmed}` : trimmed;
      buffer = "";
      if (full) steps.push(full);
    }
  }

  if (buffer.trim()) {
    steps.push(buffer.trim());
  }

  return steps;
}

function buildShellCommand(shell: ShellType, command: string): string[] {
  const effective: Exclude<ShellType, "auto"> =
    shell === "auto"
      ? process.platform === "win32"
        ? "cmd"
        : "sh"
      : shell;

  switch (effective) {
    case "cmd":
      return ["cmd", "/c", command];
    case "powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-Command", command];
    case "bash":
      return ["bash", "-c", command];
    case "sh":
    default:
      return ["sh", "-c", command];
  }
}

function prepareScriptExecution(
  shell: ShellType,
  rawScript: string,
  deploymentId: string
): { cmdArgs: string[]; scriptPath: string; displayRunner: string } {
  const isWin = process.platform === "win32";
  const effective: Exclude<ShellType, "auto"> =
    shell === "auto"
      ? isWin
        ? "cmd"
        : existsSync("/bin/bash")
        ? "bash"
        : "sh"
      : shell;

  // Normalize line endings so scripts pasted from Windows browsers run cleanly on Linux
  const normalizedUnix = rawScript.replace(/\r\n/g, "\n");
  const nonce = generateSecret(8);

  if (!isWin && shell === "auto" && normalizedUnix.startsWith("#!")) {
    const scriptPath = join(tmpdir(), `darkin-${deploymentId}-${nonce}.sh`);
    writeFileSync(scriptPath, normalizedUnix + "\n", { encoding: "utf8", mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    const firstLine = normalizedUnix.split("\n")[0]?.trim() || "#!";
    return { cmdArgs: [scriptPath], scriptPath, displayRunner: firstLine };
  }

  switch (effective) {
    case "cmd": {
      const scriptPath = join(tmpdir(), `darkin-${deploymentId}-${nonce}.cmd`);
      const content = rawScript.replace(/\r?\n/g, "\r\n") + "\r\n";
      writeFileSync(scriptPath, content, { encoding: "utf8", mode: 0o700 });
      return {
        cmdArgs: ["cmd", "/c", scriptPath],
        scriptPath,
        displayRunner: "cmd /c",
      };
    }
    case "powershell": {
      const scriptPath = join(tmpdir(), `darkin-${deploymentId}-${nonce}.ps1`);
      const content = `$ErrorActionPreference = 'Stop'\r\n${rawScript.replace(/\r?\n/g, "\r\n")}\r\n`;
      writeFileSync(scriptPath, content, { encoding: "utf8", mode: 0o700 });
      return {
        cmdArgs: [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        scriptPath,
        displayRunner: "powershell -File",
      };
    }
    case "bash": {
      const scriptPath = join(tmpdir(), `darkin-${deploymentId}-${nonce}.sh`);
      writeFileSync(scriptPath, normalizedUnix + "\n", { encoding: "utf8", mode: 0o700 });
      return {
        cmdArgs: ["bash", "-e", "-o", "pipefail", scriptPath],
        scriptPath,
        displayRunner: "bash -e -o pipefail",
      };
    }
    case "sh":
    default: {
      const scriptPath = join(tmpdir(), `darkin-${deploymentId}-${nonce}.sh`);
      writeFileSync(scriptPath, normalizedUnix + "\n", { encoding: "utf8", mode: 0o700 });
      return {
        cmdArgs: ["sh", "-e", scriptPath],
        scriptPath,
        displayRunner: "sh -e",
      };
    }
  }
}

async function killProcessTree(proc: Bun.Subprocess): Promise<void> {
  try {
    if (process.platform === "win32" && proc.pid) {
      const killer = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await killer.exited;
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already exited
        }
      }, 2000);
    }
  } catch {
    try {
      proc.kill();
    } catch {
      // Already exited
    }
  }
}

export class QueueFullError extends Error {
  constructor(projectName: string) {
    super(`Build queue for "${projectName}" is full (max ${MAX_QUEUE_PER_PROJECT} pending builds).`);
    this.name = "QueueFullError";
  }
}

export function enqueueDeployment(params: {
  project: Project;
  trigger: TriggerType;
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  triggeredBy?: string;
}): Deployment {
  const existingQueue = projectQueues.get(params.project.id);
  if (existingQueue && existingQueue.length >= MAX_QUEUE_PER_PROJECT) {
    throw new QueueFullError(params.project.name);
  }

  const deployment = createDeploymentRecord({
    projectId: params.project.id,
    trigger: params.trigger,
    branch: params.branch || params.project.branch,
    commitHash: params.commitHash,
    commitMessage: params.commitMessage,
    triggeredBy: params.triggeredBy,
  });

  activeLogs.set(deployment.id, "");

  emitGlobalEvent({
    type: "deployment_created",
    projectId: params.project.id,
    deploymentId: deployment.id,
    status: deployment.status,
    buildNumber: deployment.buildNumber,
  });

  const queue = projectQueues.get(params.project.id) ?? [];
  queue.push(deployment.id);
  projectQueues.set(params.project.id, queue);

  void processProjectQueue(params.project.id);
  return deployment;
}

export async function cancelDeployment(deploymentId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const deployment = getDeploymentById(deploymentId);
  if (!deployment) {
    return { ok: false, message: "Deployment not found" };
  }

  if (deployment.status === "queued") {
    const queue = projectQueues.get(deployment.projectId);
    if (queue) {
      const idx = queue.indexOf(deploymentId);
      if (idx !== -1) queue.splice(idx, 1);
    }
    const now = new Date().toISOString();
    const cancelMsg = "\n[darkin] Build cancelled while queued.\n";
    const logs = (activeLogs.get(deploymentId) ?? deployment.logs) + cancelMsg;
    updateDeployment(deploymentId, {
      status: "cancelled",
      finishedAt: now,
      durationMs: 0,
      logs,
    });
    activeLogs.delete(deploymentId);
    emitStream({
      type: "log",
      deploymentId,
      chunk: cancelMsg,
    });
    emitStream({
      type: "done",
      deploymentId,
      status: "cancelled",
      exitCode: null,
      durationMs: 0,
      finishedAt: now,
    });
    emitGlobalEvent({
      type: "deployment_updated",
      projectId: deployment.projectId,
      deploymentId,
      status: "cancelled",
      buildNumber: deployment.buildNumber,
    });
    return { ok: true, message: "Queued build cancelled" };
  }

  if (deployment.status === "running") {
    cancelledDeployments.add(deploymentId);
    const proc = activeProcs.get(deploymentId);
    if (proc) {
      await killProcessTree(proc);
    }
    return { ok: true, message: "Cancellation signal sent" };
  }

  return { ok: false, message: `Deployment is already ${deployment.status}` };
}

async function processProjectQueue(projectId: string): Promise<void> {
  if (runningProjects.has(projectId)) return;
  const queue = projectQueues.get(projectId);
  if (!queue || queue.length === 0) return;

  runningProjects.add(projectId);
  try {
    while (queue.length > 0) {
      const deploymentId = queue.shift()!;
      await runSingleDeployment(deploymentId);
    }
  } finally {
    runningProjects.delete(projectId);
    if ((projectQueues.get(projectId)?.length ?? 0) === 0) {
      projectQueues.delete(projectId);
    }
  }
}

async function pipeStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk: (text: string) => void
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch {
    // Stream closed on kill
  } finally {
    reader.releaseLock();
  }
}

async function runSingleDeployment(deploymentId: string): Promise<void> {
  const deployment = getDeploymentById(deploymentId);
  if (!deployment) return;

  const project = getProjectById(deployment.projectId);
  if (!project) {
    updateDeployment(deploymentId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      logs: "[darkin] Project no longer exists.\n",
    });
    activeLogs.delete(deploymentId);
    return;
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let logBuffer = "";
  let lastFlushMs = 0;

  const customEnv = parseEnvVars(project.envVars);
  const redactLog = createLogRedactor({
    webhookSecret: project.webhookSecret,
    authToken: Bun.env.DARKIN_TOKEN?.trim(),
    customEnv,
  });

  const appendLog = (rawChunk: string) => {
    const chunk = redactLog(rawChunk);
    if (logBuffer.length < MAX_LOG_CHARS) {
      logBuffer += chunk;
      if (logBuffer.length >= MAX_LOG_CHARS) {
        logBuffer =
          logBuffer.slice(0, MAX_LOG_CHARS) +
          "\n[darkin] ... log truncated (max 500KB reached) ...\n";
      }
    }
    activeLogs.set(deploymentId, logBuffer);
    emitStream({ type: "log", deploymentId, chunk });

    const now = Date.now();
    if (now - lastFlushMs > 1000) {
      lastFlushMs = now;
      updateDeployment(deploymentId, { logs: redactLog(logBuffer) });
    }
  };

  updateDeployment(deploymentId, {
    status: "running",
    startedAt,
  });

  emitStream({
    type: "status",
    deploymentId,
    status: "running",
  });
  emitGlobalEvent({
    type: "deployment_updated",
    projectId: project.id,
    deploymentId,
    status: "running",
    buildNumber: deployment.buildNumber,
  });

  const finish = (status: DeploymentStatus, exitCode: number | null) => {
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const durationMs = finishedAtMs - startedAtMs;

    const badge =
      status === "success"
        ? "SUCCESS"
        : status === "cancelled"
        ? "CANCELLED"
        : "FAILED";
    appendLog(
      `\n────────────────────────────────────────────────────────\n` +
        `[darkin] Build #${deployment.buildNumber} ${badge} ` +
        `(exit=${exitCode ?? "n/a"}, duration=${(durationMs / 1000).toFixed(2)}s)\n`
    );

    updateDeployment(deploymentId, {
      status,
      exitCode,
      finishedAt,
      durationMs,
      logs: redactLog(logBuffer),
    });

    activeProcs.delete(deploymentId);
    cancelledDeployments.delete(deploymentId);
    activeLogs.delete(deploymentId);

    emitStream({
      type: "done",
      deploymentId,
      status,
      exitCode,
      durationMs,
      finishedAt,
    });
    emitGlobalEvent({
      type: "deployment_updated",
      projectId: project.id,
      deploymentId,
      status,
      buildNumber: deployment.buildNumber,
    });
  };

  const runMode = project.runMode === "script" ? "script" : "steps";

  appendLog(
    `[darkin] Starting build #${deployment.buildNumber} for "${project.name}" (${project.slug})\n` +
      `[darkin] Trigger: ${deployment.trigger} by ${deployment.triggeredBy || "system"}\n` +
      `[darkin] WorkDir: ${project.workDir}\n` +
      `[darkin] Mode: ${runMode} | Shell: ${project.shell} (${process.platform}) | Timeout: ${project.timeoutSec}s\n` +
      (deployment.branch ? `[darkin] Branch: ${deployment.branch}\n` : "") +
      (deployment.commitHash
        ? `[darkin] Commit: ${deployment.commitHash.slice(0, 8)} ${deployment.commitMessage}\n`
        : "") +
      `────────────────────────────────────────────────────────\n`
  );

  if (!existsSync(project.workDir) || !statSync(project.workDir).isDirectory()) {
    appendLog(
      `\n[darkin] ERROR: Working directory does not exist or is not a folder:\n` +
        `         ${project.workDir}\n`
    );
    finish("failed", 1);
    return;
  }

  const trimmedScript = project.commands.trim();
  if (!trimmedScript) {
    appendLog(`\n[darkin] ERROR: No executable commands configured.\n`);
    finish("failed", 1);
    return;
  }

  const steps = runMode === "steps" ? parseCommandSteps(project.commands) : [];
  if (runMode === "steps" && steps.length === 0) {
    appendLog(`\n[darkin] ERROR: No executable commands configured.\n`);
    finish("failed", 1);
    return;
  }

  const baseEnv: Record<string, string | undefined> = { ...process.env };
  // Never leak admin authentication token to child build processes
  delete baseEnv.DARKIN_TOKEN;

  const env: Record<string, string | undefined> = {
    ...baseEnv,
    CI: "true",
    DARKIN_PROJECT: project.name,
    DARKIN_SLUG: project.slug,
    DARKIN_BUILD_NUMBER: String(deployment.buildNumber),
    DARKIN_DEPLOYMENT_ID: deployment.id,
    DARKIN_BRANCH: deployment.branch || project.branch,
    DARKIN_TRIGGER: deployment.trigger,
    ...customEnv,
  };

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    appendLog(
      `\n[darkin] ERROR: Build exceeded timeout of ${project.timeoutSec}s. Terminating...\n`
    );
    const proc = activeProcs.get(deploymentId);
    if (proc) {
      void killProcessTree(proc);
    }
  }, project.timeoutSec * 1000);

  let tempScriptPath: string | null = null;
  try {
    if (runMode === "script") {
      if (cancelledDeployments.has(deploymentId)) {
        appendLog(`\n[darkin] Build cancelled by user.\n`);
        finish("cancelled", null);
        return;
      }

      const prepared = prepareScriptExecution(project.shell, trimmedScript, deploymentId);
      tempScriptPath = prepared.scriptPath;

      const scriptStart = Date.now();
      appendLog(`\n▶ [Script] Running full script via ${prepared.displayRunner}\n`);

      const proc = Bun.spawn(prepared.cmdArgs, {
        cwd: project.workDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      activeProcs.set(deploymentId, proc);

      await Promise.all([
        pipeStream(proc.stdout, appendLog),
        pipeStream(proc.stderr, appendLog),
      ]);

      const exitCode = await proc.exited;
      activeProcs.delete(deploymentId);

      const scriptDur = ((Date.now() - scriptStart) / 1000).toFixed(2);

      if (cancelledDeployments.has(deploymentId)) {
        appendLog(`\n[darkin] Script stopped (cancelled by user).\n`);
        finish("cancelled", exitCode);
        return;
      }

      if (timedOut) {
        finish("failed", 124);
        return;
      }

      if (exitCode !== 0) {
        appendLog(`\n✖ [Script] Failed with exit code ${exitCode} (${scriptDur}s)\n`);
        finish("failed", exitCode);
        return;
      }

      appendLog(`✔ [Script] Completed (${scriptDur}s)\n`);
      finish("success", 0);
      return;
    }

    for (let i = 0; i < steps.length; i++) {
      if (cancelledDeployments.has(deploymentId)) {
        appendLog(`\n[darkin] Build cancelled by user.\n`);
        finish("cancelled", null);
        return;
      }
      if (timedOut) {
        finish("failed", 124);
        return;
      }

      const step = steps[i]!;
      const stepStart = Date.now();
      appendLog(`\n▶ [Step ${i + 1}/${steps.length}] $ ${step}\n`);

      const cmdArgs = buildShellCommand(project.shell, step);
      const proc = Bun.spawn(cmdArgs, {
        cwd: project.workDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      activeProcs.set(deploymentId, proc);

      await Promise.all([
        pipeStream(proc.stdout, appendLog),
        pipeStream(proc.stderr, appendLog),
      ]);

      const exitCode = await proc.exited;
      activeProcs.delete(deploymentId);

      const stepDur = ((Date.now() - stepStart) / 1000).toFixed(2);

      if (cancelledDeployments.has(deploymentId)) {
        appendLog(`\n[darkin] Step ${i + 1} stopped (cancelled by user).\n`);
        finish("cancelled", exitCode);
        return;
      }

      if (timedOut) {
        finish("failed", 124);
        return;
      }

      if (exitCode !== 0) {
        appendLog(
          `\n✖ [Step ${i + 1}/${steps.length}] Failed with exit code ${exitCode} (${stepDur}s)\n`
        );
        finish("failed", exitCode);
        return;
      }

      appendLog(`✔ [Step ${i + 1}/${steps.length}] Completed (${stepDur}s)\n`);
    }

    finish("success", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(`\n[darkin] UNEXPECTED ERROR: ${message}\n`);
    finish("failed", 1);
  } finally {
    clearTimeout(timeoutHandle);
    if (tempScriptPath) {
      try {
        rmSync(tempScriptPath, { force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}
