export type ShellType = "auto" | "sh" | "bash" | "cmd" | "powershell";

export type DeploymentStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export type TriggerType =
  | "manual"
  | "webhook:github"
  | "webhook:gitlab"
  | "webhook:custom";

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  repoUrl: string;
  branch: string;
  workDir: string;
  commands: string;
  envVars: string;
  shell: ShellType;
  webhookSecret: string;
  autoDeploy: boolean;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithStats extends Project {
  lastDeployment: DeploymentSummary | null;
  totalDeployments: number;
  successCount: number;
  isRunning: boolean;
  queuedCount: number;
}

export interface Deployment {
  id: string;
  buildNumber: number;
  projectId: string;
  status: DeploymentStatus;
  trigger: TriggerType;
  branch: string;
  commitHash: string;
  commitMessage: string;
  triggeredBy: string;
  logs: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export type DeploymentSummary = Omit<Deployment, "logs">;

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
  repoUrl?: string;
  branch?: string;
  workDir: string;
  commands: string;
  envVars?: string;
  shell?: ShellType;
  webhookSecret?: string;
  autoDeploy?: boolean;
  timeoutSec?: number;
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  description?: string;
  repoUrl?: string;
  branch?: string;
  workDir?: string;
  commands?: string;
  envVars?: string;
  shell?: ShellType;
  webhookSecret?: string;
  autoDeploy?: boolean;
  timeoutSec?: number;
}

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function generateSecret(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function parseEnvVars(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw?.trim()) return result;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}
