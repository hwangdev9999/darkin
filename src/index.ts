import { Elysia, t } from "elysia";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  QueueFullError,
  cancelDeployment,
  emitGlobalEvent,
  enqueueDeployment,
  getLiveLogs,
  subscribeDeployment,
  subscribeGlobal,
} from "./runner";
import { generateSecret } from "./types";
import {
  SECURITY_HEADERS,
  SESSION_COOKIE_NAME,
  buildClearSessionCookie,
  buildSessionCookie,
  clearAuthFailures,
  deriveSessionValue,
  getClientKey,
  getRateLimitRemainingSec,
  parseCookie,
  recordAuthFailure,
  safeEqual,
  verifySameOrigin,
} from "./security";
import { handleWebhookRequest } from "./webhook";

const HOST = Bun.env.HOST ?? "0.0.0.0";
const PORT = Number(Bun.env.PORT ?? 7554);
const AUTH_TOKEN = Bun.env.DARKIN_TOKEN?.trim() || "";
const EXPECTED_SESSION = AUTH_TOKEN ? deriveSessionValue(AUTH_TOKEN) : "";
const DEFAULT_WORKDIR = Bun.env.DARKIN_WORKDIR?.trim() || process.cwd();
const PUBLIC_DIR = resolve(import.meta.dir, "..", "public");
const MAX_SSE_CLIENTS = 50;

let activeSseClients = 0;

const recovered = recoverStuckDeployments();
if (recovered > 0) {
  console.log(`[darkin] Recovered ${recovered} interrupted deployment(s).`);
}

function readGitBranchSafely(targetDir: string): { isGit: boolean; branch: string } {
  const gitEntry = join(targetDir, ".git");
  if (!existsSync(gitEntry)) {
    return { isGit: false, branch: "" };
  }

  try {
    let gitDir = gitEntry;
    const st = statSync(gitEntry);
    if (st.isFile()) {
      const pointer = readFileSync(gitEntry, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (match?.[1]) {
        gitDir = resolve(targetDir, match[1].trim());
      }
    }

    const headPath = join(gitDir, "HEAD");
    if (!existsSync(headPath)) {
      return { isGit: true, branch: "" };
    }
    const head = readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) {
      return { isGit: true, branch: head.slice("ref: refs/heads/".length).trim() };
    }
    return { isGit: true, branch: head.slice(0, 8) };
  } catch {
    return { isGit: true, branch: "" };
  }
}

function checkAuthorization(
  request: Request,
  remoteIp?: string | null
): {
  ok: boolean;
  viaHeader?: boolean;
  rateLimitedSec?: number;
} {
  const headerToken =
    request.headers.get("x-darkin-token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!AUTH_TOKEN) {
    return { ok: true, viaHeader: Boolean(headerToken) };
  }

  const clientKey = getClientKey(request, remoteIp);
  const waitSec = getRateLimitRemainingSec(clientKey);
  if (waitSec > 0) {
    return { ok: false, rateLimitedSec: waitSec };
  }

  const cookieVal = parseCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (cookieVal && safeEqual(cookieVal, EXPECTED_SESSION)) {
    return { ok: true, viaHeader: false };
  }

  if (headerToken) {
    if (safeEqual(headerToken, AUTH_TOKEN)) {
      clearAuthFailures(clientKey);
      return { ok: true, viaHeader: true };
    }
    recordAuthFailure(clientKey);
  }

  return { ok: false };
}

function sseHeaders(): HeadersInit {
  return {
    ...SECURITY_HEADERS,
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

const RunModeSchema = t.Union([t.Literal("steps"), t.Literal("script")]);

const app = new Elysia()
  .onAfterHandle(({ set }) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      if (!set.headers[key]) {
        set.headers[key] = value;
      }
    }
  })

  // Serve Web UI
  .get("/", () =>
    new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
      },
    })
  )
  .get("/assets/styles.css", () =>
    new Response(Bun.file(join(PUBLIC_DIR, "styles.css")), {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/css; charset=utf-8",
      },
    })
  )
  .get("/assets/app.js", () =>
    new Response(Bun.file(join(PUBLIC_DIR, "app.js")), {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "application/javascript; charset=utf-8",
      },
    })
  )

  // Public Health endpoint (minimal info only)
  .get("/api/health", () => ({
    ok: true,
    service: "darkin",
    authRequired: Boolean(AUTH_TOKEN),
  }))

  // Cookie session authentication endpoints
  .post(
    "/api/auth/login",
    ({ body, request, set }) => {
      const remoteIp = app.server?.requestIP(request)?.address ?? null;
      if (!verifySameOrigin(request, remoteIp)) {
        set.status = 403;
        return { ok: false, error: "Forbidden: Cross-origin login blocked." };
      }
      if (!AUTH_TOKEN) {
        return { ok: true, authRequired: false };
      }

      const clientKey = getClientKey(request, remoteIp);
      const waitSec = getRateLimitRemainingSec(clientKey);
      if (waitSec > 0) {
        set.status = 429;
        return {
          ok: false,
          error: `Quá nhiều lần nhập sai. Vui lòng thử lại sau ${waitSec}s.`,
        };
      }

      const candidate = body.token.trim();
      if (!candidate || !safeEqual(candidate, AUTH_TOKEN)) {
        recordAuthFailure(clientKey);
        set.status = 401;
        return { ok: false, error: "Token không chính xác." };
      }

      clearAuthFailures(clientKey);
      set.headers["set-cookie"] = buildSessionCookie(request, EXPECTED_SESSION, remoteIp);
      return { ok: true };
    },
    {
      body: t.Object({
        token: t.String({ maxLength: 512 }),
      }),
    }
  )
  .post("/api/auth/logout", ({ request, set }) => {
    const remoteIp = app.server?.requestIP(request)?.address ?? null;
    if (!verifySameOrigin(request, remoteIp)) {
      set.status = 403;
      return { ok: false, error: "Forbidden: Cross-origin request blocked." };
    }
    set.headers["set-cookie"] = buildClearSessionCookie(request, remoteIp);
    return { ok: true };
  })

  // Webhooks (use per-project webhookSecret, independent of dashboard token)
  .post(
    "/webhook",
    async ({ request, query, set }) => {
      const remoteIp = app.server?.requestIP(request)?.address ?? null;
      const res = await handleWebhookRequest({ request, query, remoteIp });
      set.status = res.status;
      return res.body;
    },
    { detail: { summary: "Webhook deploy (default endpoint)" } }
  )
  .post(
    "/webhook/:slug",
    async ({ params, request, query, set }) => {
      const remoteIp = app.server?.requestIP(request)?.address ?? null;
      const res = await handleWebhookRequest({
        slug: params.slug,
        request,
        query,
        remoteIp,
      });
      set.status = res.status;
      return res.body;
    },
    { detail: { summary: "Webhook deploy by project slug" } }
  )

  // Protected API group
  .group("/api", (api) =>
    api
      .onBeforeHandle(({ request, set }) => {
        const remoteIp = app.server?.requestIP(request)?.address ?? null;
        const auth = checkAuthorization(request, remoteIp);
        if (!auth.ok) {
          if (auth.rateLimitedSec) {
            set.status = 429;
            return {
              ok: false,
              error: `Quá nhiều lần xác thực sai. Thử lại sau ${auth.rateLimitedSec}s.`,
            };
          }
          set.status = 401;
          return { ok: false, error: "Unauthorized. Provide a valid DARKIN_TOKEN." };
        }

        // Enforce Same-Origin CSRF protection for browser/cookie-based mutations
        if (!auth.viaHeader && !verifySameOrigin(request, remoteIp)) {
          set.status = 403;
          return {
            ok: false,
            error: "Forbidden: Cross-origin request blocked (CSRF protection).",
          };
        }
      })

      // Dashboard overview (includes system info behind auth)
      .get("/stats", () => ({
        ok: true,
        stats: getDashboardStats(),
        recentDeployments: listRecentDeployments(15),
        system: {
          runtime: `bun ${Bun.version}`,
          platform: process.platform,
          cwd: DEFAULT_WORKDIR,
          uptimeSec: Math.floor(process.uptime()),
          authRequired: Boolean(AUTH_TOKEN),
        },
      }))

      // Global SSE for live dashboard refresh
      .get("/events", ({ request, set }) => {
        if (activeSseClients >= MAX_SSE_CLIENTS) {
          set.status = 429;
          return { ok: false, error: "Too many active live connections." };
        }

        const encoder = new TextEncoder();
        let cleanup: (() => void) | null = null;
        let closed = false;
        activeSseClients += 1;

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
              if (closed) return;
              closed = true;
              activeSseClients = Math.max(0, activeSseClients - 1);
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

      // Check working directory helper for UI (reads .git/HEAD directly without spawning git)
      .post(
        "/utils/check-dir",
        ({ body }) => {
          const targetPath = body.path.trim();
          if (!targetPath) {
            return { ok: true, exists: false, isDirectory: false, isGit: false, branch: "" };
          }

          const exists = existsSync(targetPath);
          const isDirectory = exists && statSync(targetPath).isDirectory();
          const gitInfo = isDirectory
            ? readGitBranchSafely(targetPath)
            : { isGit: false, branch: "" };

          return {
            ok: true,
            exists,
            isDirectory,
            isGit: gitInfo.isGit,
            branch: gitInfo.branch,
          };
        },
        {
          body: t.Object({
            path: t.String({ maxLength: 500 }),
          }),
        }
      )

      // Projects CRUD (omit secrets from overview list; full project returned by GET /api/projects/:id)
      .get("/projects", () => ({
        ok: true,
        projects: listProjects().map(({ webhookSecret: _s, envVars: _e, ...safe }) => safe),
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
            name: t.String({ minLength: 1, maxLength: 120 }),
            slug: t.Optional(t.String({ maxLength: 80 })),
            description: t.Optional(t.String({ maxLength: 500 })),
            repoUrl: t.Optional(t.String({ maxLength: 500 })),
            branch: t.Optional(t.String({ maxLength: 120 })),
            workDir: t.String({ minLength: 1, maxLength: 500 }),
            commands: t.String({ minLength: 1, maxLength: 65536 }),
            runMode: t.Optional(RunModeSchema),
            envVars: t.Optional(t.String({ maxLength: 32768 })),
            shell: t.Optional(ShellSchema),
            webhookSecret: t.Optional(t.String({ maxLength: 256 })),
            autoDeploy: t.Optional(t.Boolean()),
            timeoutSec: t.Optional(t.Number({ minimum: 10, maximum: 86400 })),
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
            name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
            slug: t.Optional(t.String({ maxLength: 80 })),
            description: t.Optional(t.String({ maxLength: 500 })),
            repoUrl: t.Optional(t.String({ maxLength: 500 })),
            branch: t.Optional(t.String({ maxLength: 120 })),
            workDir: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
            commands: t.Optional(t.String({ minLength: 1, maxLength: 65536 })),
            runMode: t.Optional(RunModeSchema),
            envVars: t.Optional(t.String({ maxLength: 32768 })),
            shell: t.Optional(ShellSchema),
            webhookSecret: t.Optional(t.String({ maxLength: 256 })),
            autoDeploy: t.Optional(t.Boolean()),
            timeoutSec: t.Optional(t.Number({ minimum: 10, maximum: 86400 })),
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
          try {
            const deployment = enqueueDeployment({
              project,
              trigger: "manual",
              branch: body?.branch || project.branch,
              commitMessage: body?.note || "",
              triggeredBy: body?.triggeredBy || "Dashboard UI",
            });
            set.status = 202;
            return { ok: true, deployment };
          } catch (err) {
            if (err instanceof QueueFullError) {
              set.status = 429;
              return { ok: false, error: err.message };
            }
            throw err;
          }
        },
        {
          body: t.Optional(
            t.Object({
              branch: t.Optional(t.String({ maxLength: 120 })),
              note: t.Optional(t.String({ maxLength: 500 })),
              triggeredBy: t.Optional(t.String({ maxLength: 120 })),
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
        if (activeSseClients >= MAX_SSE_CLIENTS) {
          set.status = 429;
          return { ok: false, error: "Too many active live log connections." };
        }

        const encoder = new TextEncoder();
        let cleanup: (() => void) | null = null;
        let closed = false;
        activeSseClients += 1;

        const releaseClient = () => {
          if (closed) return;
          closed = true;
          activeSseClients = Math.max(0, activeSseClients - 1);
        };

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
              releaseClient();
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
              releaseClient();
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
            cleanup ? cleanup() : releaseClient();
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
    } else {
      console.warn(
        `[darkin] WARNING: DARKIN_TOKEN is not set! Do NOT expose port ${PORT} publicly without setting DARKIN_TOKEN.`
      );
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
