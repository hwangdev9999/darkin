import { Elysia, t } from "elysia";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  clearProjectDeployments,
  createProject,
  deleteProject,
  getDashboardStats,
  getDeploymentById,
  getProjectById,
  listProjectDeployments,
  listProjects,
  listRecentDeployments,
  recoverStuckDeployments,
  updateProject,
} from "./db";
import {
  cancelDeployment,
  emitGlobalEvent,
  enqueueDeployment,
  getLiveLogs,
  subscribeDeployment,
  subscribeGlobal,
} from "./runner";
import { generateSecret } from "./types";
import { handleWebhookRequest } from "./webhook";

const HOST = Bun.env.HOST ?? "0.0.0.0";
const PORT = Number(Bun.env.PORT ?? 7554);
const AUTH_TOKEN = Bun.env.DARKIN_TOKEN?.trim() || "";
const DEFAULT_WORKDIR = Bun.env.DARKIN_WORKDIR?.trim() || process.cwd();
const PUBLIC_DIR = resolve(import.meta.dir, "..", "public");

const recovered = recoverStuckDeployments();
if (recovered > 0) {
  console.log(`[darkin] Recovered ${recovered} interrupted deployment(s).`);
}

function isAuthorized(request: Request, query: Record<string, string | undefined>): boolean {
  if (!AUTH_TOKEN) return true;
  const headerToken =
    request.headers.get("x-darkin-token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (headerToken === AUTH_TOKEN) return true;
  if (query.token === AUTH_TOKEN) return true;
  return false;
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

const ShellSchema = t.Union([
  t.Literal("auto"),
  t.Literal("sh"),
  t.Literal("bash"),
  t.Literal("cmd"),
  t.Literal("powershell"),
]);

const app = new Elysia()
  // Serve Web UI
  .get("/", () => Bun.file(join(PUBLIC_DIR, "index.html")))
  .get("/assets/styles.css", () =>
    new Response(Bun.file(join(PUBLIC_DIR, "styles.css")), {
      headers: { "Content-Type": "text/css; charset=utf-8" },
    })
  )
  .get("/assets/app.js", () =>
    new Response(Bun.file(join(PUBLIC_DIR, "app.js")), {
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    })
  )

  // Public Health endpoint
  .get("/api/health", () => ({
    ok: true,
    service: "darkin",
    runtime: `bun ${Bun.version}`,
    platform: process.platform,
    cwd: DEFAULT_WORKDIR,
    authRequired: Boolean(AUTH_TOKEN),
    uptimeSec: Math.floor(process.uptime()),
  }))

  // Webhooks (use per-project webhookSecret, independent of dashboard token)
  .post(
    "/webhook",
    async ({ request, query, set }) => {
      const res = await handleWebhookRequest({ request, query });
      set.status = res.status;
      return res.body;
    },
    { detail: { summary: "Webhook deploy (default endpoint)" } }
  )
  .post(
    "/webhook/:slug",
    async ({ params, request, query, set }) => {
      const res = await handleWebhookRequest({
        slug: params.slug,
        request,
        query,
      });
      set.status = res.status;
      return res.body;
    },
    { detail: { summary: "Webhook deploy by project slug" } }
  )

  // Protected API group
  .group("/api", (api) =>
    api
      .onBeforeHandle(({ request, query, set }) => {
        if (!isAuthorized(request, query)) {
          set.status = 401;
          return { ok: false, error: "Unauthorized. Provide a valid DARKIN_TOKEN." };
        }
      })

      // Dashboard overview
      .get("/stats", () => ({
        ok: true,
        stats: getDashboardStats(),
        recentDeployments: listRecentDeployments(15),
      }))

      // Global SSE for live dashboard refresh
      .get("/events", ({ request }) => {
        const encoder = new TextEncoder();
        let cleanup: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
                );
              } catch {
                // Closed
              }
            };

            send("connected", { ok: true, time: new Date().toISOString() });

            const unsub = subscribeGlobal((evt) => {
              send("update", evt);
            });

            const keepAlive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
              } catch {
                // Closed
              }
            }, 15_000);

            cleanup = () => {
              clearInterval(keepAlive);
              unsub();
            };

            request.signal.addEventListener("abort", () => {
              cleanup?.();
              try {
                controller.close();
              } catch {
                // Already closed
              }
            });
          },
          cancel() {
            cleanup?.();
          },
        });

        return new Response(stream, { headers: sseHeaders() });
      })

      // Check working directory helper for UI
      .post(
        "/utils/check-dir",
        async ({ body }) => {
          const targetPath = body.path.trim();
          if (!targetPath) {
            return { ok: true, exists: false, isDirectory: false, isGit: false, branch: "" };
          }

          const exists = existsSync(targetPath);
          const isDirectory = exists && statSync(targetPath).isDirectory();
          const isGit = isDirectory && existsSync(join(targetPath, ".git"));
          let branch = "";

          if (isGit) {
            try {
              const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
                cwd: targetPath,
                stdout: "pipe",
                stderr: "ignore",
              });
              const out = await new Response(proc.stdout).text();
              await proc.exited;
              branch = out.trim();
            } catch {
              // git might not be installed
            }
          }

          return { ok: true, exists, isDirectory, isGit, branch };
        },
        {
          body: t.Object({
            path: t.String(),
          }),
        }
      )

      // Projects CRUD
      .get("/projects", () => ({
        ok: true,
        projects: listProjects(),
      }))

      .post(
        "/projects",
        ({ body, set }) => {
          try {
            const project = createProject(body);
            emitGlobalEvent({ type: "project_created", projectId: project.id });
            set.status = 201;
            return { ok: true, project };
          } catch (err) {
            set.status = 400;
            return {
              ok: false,
              error: err instanceof Error ? err.message : "Failed to create project",
            };
          }
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1 }),
            slug: t.Optional(t.String()),
            description: t.Optional(t.String()),
            repoUrl: t.Optional(t.String()),
            branch: t.Optional(t.String()),
            workDir: t.String({ minLength: 1 }),
            commands: t.String({ minLength: 1 }),
            envVars: t.Optional(t.String()),
            shell: t.Optional(ShellSchema),
            webhookSecret: t.Optional(t.String()),
            autoDeploy: t.Optional(t.Boolean()),
            timeoutSec: t.Optional(t.Number()),
          }),
        }
      )

      .get("/projects/:id", ({ params, set }) => {
        const project = getProjectById(params.id);
        if (!project) {
          set.status = 404;
          return { ok: false, error: "Project not found" };
        }
        const deployments = listProjectDeployments(project.id, 40);
        return { ok: true, project, deployments };
      })

      .put(
        "/projects/:id",
        ({ params, body, set }) => {
          try {
            const project = updateProject(params.id, body);
            if (!project) {
              set.status = 404;
              return { ok: false, error: "Project not found" };
            }
            emitGlobalEvent({ type: "project_updated", projectId: project.id });
            return { ok: true, project };
          } catch (err) {
            set.status = 400;
            return {
              ok: false,
              error: err instanceof Error ? err.message : "Failed to update project",
            };
          }
        },
        {
          body: t.Object({
            name: t.Optional(t.String({ minLength: 1 })),
            slug: t.Optional(t.String()),
            description: t.Optional(t.String()),
            repoUrl: t.Optional(t.String()),
            branch: t.Optional(t.String()),
            workDir: t.Optional(t.String({ minLength: 1 })),
            commands: t.Optional(t.String({ minLength: 1 })),
            envVars: t.Optional(t.String()),
            shell: t.Optional(ShellSchema),
            webhookSecret: t.Optional(t.String()),
            autoDeploy: t.Optional(t.Boolean()),
            timeoutSec: t.Optional(t.Number()),
          }),
        }
      )

      .delete("/projects/:id", ({ params, set }) => {
        const deleted = deleteProject(params.id);
        if (!deleted) {
          set.status = 404;
          return { ok: false, error: "Project not found" };
        }
        emitGlobalEvent({ type: "project_deleted", projectId: params.id });
        return { ok: true };
      })

      .post("/projects/:id/regenerate-secret", ({ params, set }) => {
        const project = updateProject(params.id, {
          webhookSecret: generateSecret(),
        });
        if (!project) {
          set.status = 404;
          return { ok: false, error: "Project not found" };
        }
        return { ok: true, webhookSecret: project.webhookSecret };
      })

      // Trigger manual deploy
      .post(
        "/projects/:id/deploy",
        ({ params, body, set }) => {
          const project = getProjectById(params.id);
          if (!project) {
            set.status = 404;
            return { ok: false, error: "Project not found" };
          }
          const deployment = enqueueDeployment({
            project,
            trigger: "manual",
            branch: body?.branch || project.branch,
            commitMessage: body?.note || "",
            triggeredBy: body?.triggeredBy || "Dashboard UI",
          });
          set.status = 202;
          return { ok: true, deployment };
        },
        {
          body: t.Optional(
            t.Object({
              branch: t.Optional(t.String()),
              note: t.Optional(t.String()),
              triggeredBy: t.Optional(t.String()),
            })
          ),
        }
      )

      .delete("/projects/:id/deployments", ({ params, set }) => {
        const project = getProjectById(params.id);
        if (!project) {
          set.status = 404;
          return { ok: false, error: "Project not found" };
        }
        const cleared = clearProjectDeployments(project.id);
        return { ok: true, cleared };
      })

      // Deployment inspection & control
      .get("/deployments/:id", ({ params, set }) => {
        const deployment = getDeploymentById(params.id);
        if (!deployment) {
          set.status = 404;
          return { ok: false, error: "Deployment not found" };
        }
        const liveLogs = getLiveLogs(deployment.id);
        if (liveLogs !== null) {
          deployment.logs = liveLogs;
        }
        return { ok: true, deployment };
      })

      .post("/deployments/:id/cancel", async ({ params, set }) => {
        const result = await cancelDeployment(params.id);
        if (!result.ok) {
          set.status = 400;
        }
        return result;
      })

      // Real-time SSE log stream for a deployment
      .get("/deployments/:id/stream", ({ params, request, set }) => {
        const deployment = getDeploymentById(params.id);
        if (!deployment) {
          set.status = 404;
          return { ok: false, error: "Deployment not found" };
        }

        const encoder = new TextEncoder();
        let cleanup: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
                );
              } catch {
                // Closed
              }
            };

            const currentLogs = getLiveLogs(deployment.id) ?? deployment.logs;
            send("init", {
              id: deployment.id,
              buildNumber: deployment.buildNumber,
              status: deployment.status,
              exitCode: deployment.exitCode,
              durationMs: deployment.durationMs,
              logs: currentLogs,
            });

            if (
              deployment.status === "success" ||
              deployment.status === "failed" ||
              deployment.status === "cancelled"
            ) {
              send("done", {
                status: deployment.status,
                exitCode: deployment.exitCode,
                durationMs: deployment.durationMs,
                finishedAt: deployment.finishedAt,
              });
              controller.close();
              return;
            }

            const unsub = subscribeDeployment(deployment.id, (evt) => {
              if (evt.type === "log") {
                send("log", { chunk: evt.chunk ?? "" });
              } else if (evt.type === "status") {
                send("status", { status: evt.status });
              } else if (evt.type === "done") {
                send("done", {
                  status: evt.status,
                  exitCode: evt.exitCode,
                  durationMs: evt.durationMs,
                  finishedAt: evt.finishedAt,
                });
                cleanup?.();
                try {
                  controller.close();
                } catch {
                  // Closed
                }
              }
            });

            const keepAlive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
              } catch {
                // Closed
              }
            }, 15_000);

            cleanup = () => {
              clearInterval(keepAlive);
              unsub();
            };

            request.signal.addEventListener("abort", () => {
              cleanup?.();
              try {
                controller.close();
              } catch {
                // Closed
              }
            });
          },
          cancel() {
            cleanup?.();
          },
        });

        return new Response(stream, { headers: sseHeaders() });
      })
  );

app.listen(
  {
    hostname: HOST,
    port: PORT,
    reusePort: false,
    idleTimeout: 255,
  },
  () => {
    console.log(`Darkin - Deploy Man is running at http://${HOST}:${PORT}`);
    if (AUTH_TOKEN) {
      console.log(`[darkin] Dashboard authentication enabled (DARKIN_TOKEN is set)`);
    }
  }
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[darkin] Received ${signal}, shutting down...`);
    void app.stop();
    process.exit(0);
  });
}
