import { timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "darkin_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILURES = 10;

interface RateBucket {
  count: number;
  resetAt: number;
}

const authFailureBuckets = new Map<string, RateBucket>();

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

/**
 * Constant-time string comparison (hashes both inputs with SHA-256 so length is not leaked).
 */
export function safeEqual(a: string, b: string): boolean {
  const hashA = new Bun.CryptoHasher("sha256").update(a).digest();
  const hashB = new Bun.CryptoHasher("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Derives a deterministic session token from DARKIN_TOKEN so raw token is never stored in cookies.
 */
export function deriveSessionValue(authToken: string): string {
  return new Bun.CryptoHasher("sha256", authToken)
    .update("darkin-session-v1")
    .digest("hex");
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      const raw = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function isHttpsRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function buildSessionCookie(request: Request, sessionValue: string): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isHttpsRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearSessionCookie(request: Request): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isHttpsRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function getClientKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "local";
}

function pruneExpiredBuckets(now: number): void {
  if (authFailureBuckets.size < 200) return;
  for (const [key, bucket] of authFailureBuckets) {
    if (now >= bucket.resetAt) authFailureBuckets.delete(key);
  }
}

export function getRateLimitRemainingSec(clientKey: string): number {
  const now = Date.now();
  const bucket = authFailureBuckets.get(clientKey);
  if (!bucket) return 0;
  if (now >= bucket.resetAt) {
    authFailureBuckets.delete(clientKey);
    return 0;
  }
  if (bucket.count >= RATE_MAX_FAILURES) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  return 0;
}

export function recordAuthFailure(clientKey: string): void {
  const now = Date.now();
  pruneExpiredBuckets(now);
  const existing = authFailureBuckets.get(clientKey);
  if (!existing || now >= existing.resetAt) {
    authFailureBuckets.set(clientKey, {
      count: 1,
      resetAt: now + RATE_WINDOW_MS,
    });
  } else {
    existing.count += 1;
  }
}

export function clearAuthFailures(clientKey: string): void {
  authFailureBuckets.delete(clientKey);
}

const SENSITIVE_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|WEBHOOK)/i;

/**
 * Builds a fast redactor that replaces sensitive secret values with `***` in build logs.
 */
export function createLogRedactor(params: {
  webhookSecret?: string;
  authToken?: string;
  customEnv?: Record<string, string>;
}): (text: string) => string {
  const rawSecrets = new Set<string>();

  if (params.authToken && params.authToken.length >= 6) {
    rawSecrets.add(params.authToken);
  }
  if (params.webhookSecret && params.webhookSecret.length >= 6) {
    rawSecrets.add(params.webhookSecret);
  }
  if (params.customEnv) {
    for (const [key, val] of Object.entries(params.customEnv)) {
      if (val && val.length >= 6 && SENSITIVE_KEY_PATTERN.test(key)) {
        rawSecrets.add(val);
      }
    }
  }

  const secrets = Array.from(rawSecrets).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) {
    return (text: string) => text;
  }

  return (text: string) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join("***");
      }
    }
    return out;
  };
}
