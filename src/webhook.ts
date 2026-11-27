import { findProjectByRepoName, getProjectBySlug } from "./db";
import { enqueueDeployment } from "./runner";
import { safeEqual } from "./security";
import type { Project, TriggerType } from "./types";

const MAX_WEBHOOK_BYTES = 1024 * 1024; // 1 MB

async function readLimitedText(
  request: Request,
  maxBytes: number
): Promise<{ text: string; tooLarge: boolean }> {
  const declaredLen = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    return { text: "", tooLarge: true };
  }

  if (!request.body) {
    return { text: "", tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { text: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(combined), tooLarge: false };
}

function verifyGithubSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string
): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(rawBody);
  const expected = `sha256=${hasher.digest("hex")}`;
  return safeEqual(expected, signatureHeader);
}

function extractBranch(ref: unknown): string {
  if (typeof ref !== "string") return "";
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function parseWebhookPayload(
  headers: Headers,
  payload: Record<string, any>
): {
  provider: TriggerType;
  event: string;
  branch: string;
  commitHash: string;
  commitMessage: string;
  triggeredBy: string;
  repoHint: string;
} {
  const ghEvent = headers.get("x-github-event");
  const glEvent = headers.get("x-gitlab-event");

  if (ghEvent) {
    const headCommit = payload?.head_commit ?? payload?.commits?.[0] ?? {};
    return {
      provider: "webhook:github",
      event: ghEvent,
      branch: extractBranch(payload?.ref) || payload?.repository?.default_branch || "",
      commitHash: String(payload?.after ?? headCommit?.id ?? ""),
      commitMessage: String(headCommit?.message ?? "").split("\n")[0] ?? "",
      triggeredBy: String(
        payload?.pusher?.name ?? payload?.sender?.login ?? "github"
      ),
      repoHint: String(
        payload?.repository?.clone_url ??
          payload?.repository?.html_url ??
          payload?.repository?.full_name ??
          payload?.repository?.name ??
          ""
      ),
    };
  }

  if (glEvent) {
    const latestCommit =
      Array.isArray(payload?.commits) && payload.commits.length > 0
        ? payload.commits[payload.commits.length - 1]
        : {};
    return {
      provider: "webhook:gitlab",
      event: glEvent,
      branch: extractBranch(payload?.ref),
      commitHash: String(payload?.after ?? payload?.checkout_sha ?? latestCommit?.id ?? ""),
      commitMessage: String(latestCommit?.message ?? "").split("\n")[0] ?? "",
      triggeredBy: String(
        payload?.user_username ?? payload?.user_name ?? "gitlab"
      ),
      repoHint: String(
        payload?.project?.git_http_url ??
          payload?.project?.web_url ??
          payload?.project?.path_with_namespace ??
          ""
      ),
    };
  }

  return {
    provider: "webhook:custom",
    event: String(payload?.event ?? "push"),
    branch: extractBranch(payload?.branch ?? payload?.ref ?? ""),
    commitHash: String(payload?.commit ?? payload?.sha ?? ""),
    commitMessage: String(payload?.message ?? ""),
    triggeredBy: String(payload?.actor ?? payload?.triggeredBy ?? "webhook"),
    repoHint: String(payload?.project ?? payload?.slug ?? payload?.repository ?? ""),
  };
}

function verifyWebhookAuth(
  project: Project,
  headers: Headers,
  querySecret: string | undefined,
  rawBody: string
): boolean {
  if (!project.webhookSecret) return true;

  const ghSig = headers.get("x-hub-signature-256");
  if (ghSig) {
    return verifyGithubSignature(rawBody, project.webhookSecret, ghSig);
  }

  const glToken = headers.get("x-gitlab-token");
  if (glToken) {
    return safeEqual(glToken, project.webhookSecret);
  }

  const customHeader =
    headers.get("x-webhook-secret") ??
    headers.get("x-darkin-secret") ??
    headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (customHeader) {
    return safeEqual(customHeader, project.webhookSecret);
  }

  if (querySecret) {
    return safeEqual(querySecret, project.webhookSecret);
  }

  return false;
}

export async function handleWebhookRequest(params: {
  slug?: string;
  request: Request;
  query: Record<string, string | undefined>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { text: rawBody, tooLarge } = await readLimitedText(
    params.request,
    MAX_WEBHOOK_BYTES
  );
  if (tooLarge) {
    return {
      status: 413,
      body: { ok: false, error: "Webhook payload too large (max 1MB)" },
    };
  }
  let payload: Record<string, any> = {};

  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Handle application/x-www-form-urlencoded (GitHub form webhook)
      const formParams = new URLSearchParams(rawBody);
      const formPayload = formParams.get("payload");
      if (formPayload) {
        try {
          payload = JSON.parse(formPayload);
        } catch {
          return { status: 400, body: { ok: false, error: "Invalid JSON payload" } };
        }
      }
    }
  }

  const meta = parseWebhookPayload(params.request.headers, payload);

  // Locate project by route slug, query param, header, or repo URL
  const slugCandidate =
    params.slug ??
    params.query.project ??
    params.query.slug ??
    params.request.headers.get("x-darkin-project") ??
    undefined;

  let project: Project | null = slugCandidate
    ? getProjectBySlug(slugCandidate)
    : null;

  if (!project && meta.repoHint) {
    project =
      getProjectBySlug(meta.repoHint) ?? findProjectByRepoName(meta.repoHint);
  }

  if (!project) {
    return {
      status: 404,
      body: {
        ok: false,
        error: slugCandidate
          ? `Project "${slugCandidate}" not found`
          : "Project not specified. Use /webhook/:slug or ?project=<slug>",
      },
    };
  }

  const authorized = verifyWebhookAuth(
    project,
    params.request.headers,
    params.query.secret,
    rawBody
  );

  if (!authorized) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "Invalid webhook secret or signature",
      },
    };
  }

  // Handle GitHub ping event cleanly
  if (meta.event === "ping") {
    return {
      status: 200,
      body: {
        ok: true,
        message: `Pong! Webhook connected for project "${project.name}".`,
      },
    };
  }

  if (!project.autoDeploy) {
    return {
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: "Auto-deploy via webhook is disabled for this project",
      },
    };
  }

  // Branch filter check
  if (
    project.branch &&
    project.branch !== "*" &&
    meta.branch &&
    meta.branch !== project.branch
  ) {
    return {
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: `Branch "${meta.branch}" does not match configured branch "${project.branch}"`,
      },
    };
  }

  const deployment = enqueueDeployment({
    project,
    trigger: meta.provider,
    branch: meta.branch || project.branch,
    commitHash: meta.commitHash,
    commitMessage: meta.commitMessage,
    triggeredBy: meta.triggeredBy,
  });

  return {
    status: 202,
    body: {
      ok: true,
      message: `Deployment #${deployment.buildNumber} queued for "${project.name}"`,
      deployment: {
        id: deployment.id,
        buildNumber: deployment.buildNumber,
        status: deployment.status,
        projectId: project.id,
        projectSlug: project.slug,
      },
    },
  };
}
