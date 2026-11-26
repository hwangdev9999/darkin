import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type CreateProjectInput,
  type Deployment,
  type DeploymentStatus,
  type DeploymentSummary,
  type Project,
  type ProjectWithStats,
  type RunMode,
  type ShellType,
  type TriggerType,
  type UpdateProjectInput,
  generateId,
  generateSecret,
  slugify,
} from "./types";

const DB_PATH = resolve(Bun.env.DARKIN_DB ?? "data/darkin.sqlite");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT 'main',
    work_dir TEXT NOT NULL,
    commands TEXT NOT NULL,
    run_mode TEXT NOT NULL DEFAULT 'steps',
    env_vars TEXT NOT NULL DEFAULT '',
    shell TEXT NOT NULL DEFAULT 'auto',
    webhook_secret TEXT NOT NULL,
    auto_deploy INTEGER NOT NULL DEFAULT 1,
    timeout_sec INTEGER NOT NULL DEFAULT 600,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    build_number INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    commit_hash TEXT NOT NULL DEFAULT '',
    commit_message TEXT NOT NULL DEFAULT '',
    triggered_by TEXT NOT NULL DEFAULT '',
    logs TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_project_build
    ON deployments(project_id, build_number DESC);
  CREATE INDEX IF NOT EXISTS idx_deployments_created
    ON deployments(created_at DESC);
`);

// Auto-migrate existing SQLite databases
const projectColumns = db.query(`PRAGMA table_info(projects)`).all() as { name: string }[];
if (!projectColumns.some((c) => c.name === "run_mode")) {
  db.exec(`ALTER TABLE projects ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'steps'`);
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  repo_url: string;
  branch: string;
  work_dir: string;
  commands: string;
  run_mode: string;
  env_vars: string;
  shell: string;
  webhook_secret: string;
  auto_deploy: number;
  timeout_sec: number;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  id: string;
  build_number: number;
  project_id: string;
  status: string;
  trigger: string;
  branch: string;
  commit_hash: string;
  commit_message: string;
  triggered_by: string;
  logs?: string;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    repoUrl: row.repo_url,
    branch: row.branch,
    workDir: row.work_dir,
    commands: row.commands,
    runMode: row.run_mode === "script" ? "script" : "steps",
    envVars: row.env_vars,
    shell: (row.shell as ShellType) || "auto",
    webhookSecret: row.webhook_secret,
    autoDeploy: row.auto_deploy === 1,
    timeoutSec: row.timeout_sec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    buildNumber: row.build_number,
    projectId: row.project_id,
    status: row.status as DeploymentStatus,
    trigger: row.trigger as TriggerType,
    branch: row.branch,
    commitHash: row.commit_hash,
    commitMessage: row.commit_message,
    triggeredBy: row.triggered_by,
    logs: row.logs ?? "",
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function mapDeploymentSummary(row: DeploymentRow): DeploymentSummary {
  return {
    id: row.id,
    buildNumber: row.build_number,
    projectId: row.project_id,
    status: row.status as DeploymentStatus,
    trigger: row.trigger as TriggerType,
    branch: row.branch,
    commitHash: row.commit_hash,
    commitMessage: row.commit_message,
    triggeredBy: row.triggered_by,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export function recoverStuckDeployments(): number {
  const now = new Date().toISOString();
  const res = db
    .query(
      `UPDATE deployments
       SET status = 'failed',
           finished_at = ?,
           logs = logs || '\n[darkin] Build interrupted because server restarted.\n'
       WHERE status IN ('running', 'queued')`
    )
    .run(now);
  return res.changes;
}

export function listProjects(): ProjectWithStats[] {
  const rows = db
    .query(`SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC`)
    .all() as ProjectRow[];

  const lastStmt = db.query(
    `SELECT id, build_number, project_id, status, trigger, branch, commit_hash, commit_message,
            triggered_by, exit_code, started_at, finished_at, duration_ms, created_at
     FROM deployments
     WHERE project_id = ?
     ORDER BY build_number DESC
     LIMIT 1`
  );

  const statsStmt = db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count
     FROM deployments
     WHERE project_id = ?`
  );

  return rows.map((row) => {
    const project = mapProject(row);
    const lastRow = lastStmt.get(project.id) as DeploymentRow | null;
    const stats = statsStmt.get(project.id) as {
      total: number;
      success_count: number | null;
      running_count: number | null;
      queued_count: number | null;
    };

    return {
      ...project,
      lastDeployment: lastRow ? mapDeploymentSummary(lastRow) : null,
      totalDeployments: stats?.total ?? 0,
      successCount: stats?.success_count ?? 0,
      isRunning: (stats?.running_count ?? 0) > 0,
      queuedCount: stats?.queued_count ?? 0,
    };
  });
}

export function getProjectById(id: string): Project | null {
  const row = db
    .query(`SELECT * FROM projects WHERE id = ?`)
    .get(id) as ProjectRow | null;
  return row ? mapProject(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = db
    .query(`SELECT * FROM projects WHERE slug = ?`)
    .get(slug) as ProjectRow | null;
  return row ? mapProject(row) : null;
}

export function findProjectByRepoName(repoFullNameOrUrl: string): Project | null {
  const normalized = repoFullNameOrUrl.toLowerCase().replace(/\.git$/, "");
  const rows = db.query(`SELECT * FROM projects`).all() as ProjectRow[];
  for (const row of rows) {
    const url = row.repo_url.toLowerCase().replace(/\.git$/, "");
    if (!url) continue;
    if (url === normalized || url.endsWith(`/${normalized}`) || normalized.endsWith(`/${row.slug}`)) {
      return mapProject(row);
    }
  }
  return null;
}

export function createProject(input: CreateProjectInput): Project {
  const id = generateId();
  const baseSlug = slugify(input.slug?.trim() || input.name);
  if (!baseSlug) {
    throw new Error("Project slug cannot be empty");
  }

  let slug = baseSlug;
  let suffix = 2;
  while (getProjectBySlug(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const now = new Date().toISOString();
  const project: Project = {
    id,
    name: input.name.trim(),
    slug,
    description: (input.description ?? "").trim(),
    repoUrl: (input.repoUrl ?? "").trim(),
    branch: (input.branch ?? "main").trim(),
    workDir: input.workDir.trim(),
    commands: input.commands.trim(),
    runMode: input.runMode === "script" ? "script" : "steps",
    envVars: input.envVars ?? "",
    shell: input.shell ?? "auto",
    webhookSecret: input.webhookSecret?.trim() || generateSecret(),
    autoDeploy: input.autoDeploy ?? true,
    timeoutSec: Math.max(10, Math.min(86400, Number(input.timeoutSec) || 600)),
    createdAt: now,
    updatedAt: now,
  };

  db.query(
    `INSERT INTO projects (
      id, name, slug, description, repo_url, branch, work_dir,
      commands, run_mode, env_vars, shell, webhook_secret, auto_deploy,
      timeout_sec, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    project.id,
    project.name,
    project.slug,
    project.description,
    project.repoUrl,
    project.branch,
    project.workDir,
    project.commands,
    project.runMode,
    project.envVars,
    project.shell,
    project.webhookSecret,
    project.autoDeploy ? 1 : 0,
    project.timeoutSec,
    project.createdAt,
    project.updatedAt
  );

  return project;
}

export function updateProject(id: string, input: UpdateProjectInput): Project | null {
  const existing = getProjectById(id);
  if (!existing) return null;

  let nextSlug = existing.slug;
  if (input.slug !== undefined && input.slug.trim()) {
    const candidate = slugify(input.slug);
    if (!candidate) throw new Error("Invalid slug");
    const clash = getProjectBySlug(candidate);
    if (clash && clash.id !== id) {
      throw new Error(`Slug "${candidate}" already exists`);
    }
    nextSlug = candidate;
  }

  const now = new Date().toISOString();
  const updated: Project = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    slug: nextSlug,
    description:
      input.description !== undefined ? input.description.trim() : existing.description,
    repoUrl: input.repoUrl !== undefined ? input.repoUrl.trim() : existing.repoUrl,
    branch: input.branch !== undefined ? input.branch.trim() : existing.branch,
    workDir: input.workDir !== undefined ? input.workDir.trim() : existing.workDir,
    commands: input.commands !== undefined ? input.commands.trim() : existing.commands,
    runMode:
      input.runMode !== undefined
        ? input.runMode === "script"
          ? "script"
          : "steps"
        : existing.runMode,
    envVars: input.envVars !== undefined ? input.envVars : existing.envVars,
    shell: input.shell !== undefined ? input.shell : existing.shell,
    webhookSecret:
      input.webhookSecret !== undefined && input.webhookSecret.trim()
        ? input.webhookSecret.trim()
        : existing.webhookSecret,
    autoDeploy: input.autoDeploy !== undefined ? input.autoDeploy : existing.autoDeploy,
    timeoutSec:
      input.timeoutSec !== undefined
        ? Math.max(10, Math.min(86400, Number(input.timeoutSec) || 600))
        : existing.timeoutSec,
    updatedAt: now,
  };

  db.query(
    `UPDATE projects SET
      name = ?, slug = ?, description = ?, repo_url = ?, branch = ?,
      work_dir = ?, commands = ?, run_mode = ?, env_vars = ?, shell = ?,
      webhook_secret = ?, auto_deploy = ?, timeout_sec = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    updated.name,
    updated.slug,
    updated.description,
    updated.repoUrl,
    updated.branch,
    updated.workDir,
    updated.commands,
    updated.runMode,
    updated.envVars,
    updated.shell,
    updated.webhookSecret,
    updated.autoDeploy ? 1 : 0,
    updated.timeoutSec,
    updated.updatedAt,
    id
  );

  return updated;
}

export function deleteProject(id: string): boolean {
  const res = db.query(`DELETE FROM projects WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function createDeploymentRecord(params: {
  projectId: string;
  trigger: TriggerType;
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  triggeredBy?: string;
}): Deployment {
  const maxRow = db
    .query(`SELECT COALESCE(MAX(build_number), 0) AS max_num FROM deployments WHERE project_id = ?`)
    .get(params.projectId) as { max_num: number };

  const buildNumber = (maxRow?.max_num ?? 0) + 1;
  const id = generateId();
  const now = new Date().toISOString();

  const deployment: Deployment = {
    id,
    buildNumber,
    projectId: params.projectId,
    status: "queued",
    trigger: params.trigger,
    branch: params.branch ?? "",
    commitHash: params.commitHash ?? "",
    commitMessage: params.commitMessage ?? "",
    triggeredBy: params.triggeredBy ?? "UI",
    logs: "",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    createdAt: now,
  };

  db.query(
    `INSERT INTO deployments (
      id, build_number, project_id, status, trigger, branch,
      commit_hash, commit_message, triggered_by, logs,
      exit_code, started_at, finished_at, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    deployment.id,
    deployment.buildNumber,
    deployment.projectId,
    deployment.status,
    deployment.trigger,
    deployment.branch,
    deployment.commitHash,
    deployment.commitMessage,
    deployment.triggeredBy,
    deployment.logs,
    deployment.exitCode,
    deployment.startedAt,
    deployment.finishedAt,
    deployment.durationMs,
    deployment.createdAt
  );

  return deployment;
}

export function updateDeployment(
  id: string,
  patch: Partial<{
    status: DeploymentStatus;
    logs: string;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
  }>
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.logs !== undefined) {
    fields.push("logs = ?");
    values.push(patch.logs);
  }
  if (patch.exitCode !== undefined) {
    fields.push("exit_code = ?");
    values.push(patch.exitCode);
  }
  if (patch.startedAt !== undefined) {
    fields.push("started_at = ?");
    values.push(patch.startedAt);
  }
  if (patch.finishedAt !== undefined) {
    fields.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (patch.durationMs !== undefined) {
    fields.push("duration_ms = ?");
    values.push(patch.durationMs);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.query(`UPDATE deployments SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function getDeploymentById(id: string): Deployment | null {
  const row = db
    .query(`SELECT * FROM deployments WHERE id = ?`)
    .get(id) as DeploymentRow | null;
  return row ? mapDeployment(row) : null;
}

export function listProjectDeployments(
  projectId: string,
  limit = 30
): DeploymentSummary[] {
  const rows = db
    .query(
      `SELECT id, build_number, project_id, status, trigger, branch, commit_hash, commit_message,
              triggered_by, exit_code, started_at, finished_at, duration_ms, created_at
       FROM deployments
       WHERE project_id = ?
       ORDER BY build_number DESC
       LIMIT ?`
    )
    .all(projectId, limit) as DeploymentRow[];
  return rows.map(mapDeploymentSummary);
}

export function listRecentDeployments(limit = 20): (DeploymentSummary & {
  projectName: string;
  projectSlug: string;
})[] {
  const rows = db
    .query(
      `SELECT d.id, d.build_number, d.project_id, d.status, d.trigger, d.branch, d.commit_hash,
              d.commit_message, d.triggered_by, d.exit_code, d.started_at, d.finished_at,
              d.duration_ms, d.created_at, p.name AS project_name, p.slug AS project_slug
       FROM deployments d
       JOIN projects p ON p.id = d.project_id
       ORDER BY d.created_at DESC
       LIMIT ?`
    )
    .all(limit) as (DeploymentRow & { project_name: string; project_slug: string })[];

  return rows.map((row) => ({
    ...mapDeploymentSummary(row),
    projectName: row.project_name,
    projectSlug: row.project_slug,
  }));
}

export function clearProjectDeployments(projectId: string): number {
  const res = db
    .query(`DELETE FROM deployments WHERE project_id = ? AND status NOT IN ('running', 'queued')`)
    .run(projectId);
  return res.changes;
}

export function getDashboardStats() {
  const projectCount = (
    db.query(`SELECT COUNT(*) AS c FROM projects`).get() as { c: number }
  ).c;

  const deployStats = db
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM deployments`
    )
    .get() as {
    total: number;
    running: number | null;
    queued: number | null;
    success: number | null;
    failed: number | null;
  };

  return {
    projects: projectCount,
    totalDeployments: deployStats.total ?? 0,
    running: deployStats.running ?? 0,
    queued: deployStats.queued ?? 0,
    success: deployStats.success ?? 0,
    failed: deployStats.failed ?? 0,
  };
}
