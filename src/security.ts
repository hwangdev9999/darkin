import { timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "darkin_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_AUTH_FAILURES = 10;
const RATE_MAX_WEBHOOK_FAILURES = 20;
const MAX_RATE_BUCKETS = 5_000;

const TRUST_PROXY = Bun.env.DARKIN_TRUST_PROXY?.trim().toLowerCase() === "true";

interface RateBucket {
  count: number;
  resetAt: number;
}

const authFailureBuckets = new Map<string, RateBucket>();
const webhookFailureBuckets = new Map<string, RateBucket>();

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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

function isLoopbackAddress(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("172.") ||
    ip.startsWith("10.")
  );
}

export function isHttpsRequest(request: Request, remoteIp?: string | null): boolean {
  if (TRUST_PROXY || (remoteIp && isLoopbackAddress(remoteIp))) {
    const forwardedProto = request.headers.get("x-forwarded-proto");
    if (forwardedProto) {
      return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
    }
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function buildSessionCookie(
  request: Request,
  sessionValue: string,
  remoteIp?: string | null
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isHttpsRequest(request, remoteIp)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearSessionCookie(
  request: Request,
  remoteIp?: string | null
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isHttpsRequest(request, remoteIp)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Resolves the real client IP without allowing untrusted X-Forwarded-For spoofing.
 * Only trusts proxy headers when DARKIN_TRUST_PROXY=true or the direct socket peer is a local/private reverse proxy.
 */
export function getClientKey(request: Request, remoteIp?: string | null): string {
  const peer = remoteIp?.trim() || "";
  const canTrustProxy = TRUST_PROXY || (peer !== "" && isLoopbackAddress(peer));

  if (canTrustProxy) {
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;

    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      // Take the rightmost proxy-appended entry when behind a single trusted reverse proxy
      const parts = xff
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }

  return peer || "unknown";
}

/**
 * CSRF protection for cookie-authenticated state-changing requests (POST/PUT/DELETE/PATCH).
 * Verifies Fetch Metadata (`Sec-Fetch-Site`) and `Origin` header match the target host.
 */
export function verifySameOrigin(request: Request, remoteIp?: string | null): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    return true;
  }

  let originHost = "";
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const canTrustProxy =
    TRUST_PROXY || Boolean(remoteIp && isLoopbackAddress(remoteIp));
  const expectedHost = (
    (canTrustProxy ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : null) ||
    request.headers.get("host")?.trim() ||
    ""
  ).toLowerCase();

  if (!expectedHost) return false;
  return originHost === expectedHost;
}

function pruneBuckets(map: Map<string, RateBucket>, now: number): void {
  if (map.size < 200) return;
  for (const [key, bucket] of map) {
    if (now >= bucket.resetAt) map.delete(key);
  }
  while (map.size >= MAX_RATE_BUCKETS) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function getBucketWaitSec(
  map: Map<string, RateBucket>,
  clientKey: string,
  maxFailures: number
): number {
  const now = Date.now();
  const bucket = map.get(clientKey);
  if (!bucket) return 0;
  if (now >= bucket.resetAt) {
    map.delete(clientKey);
    return 0;
  }
  if (bucket.count >= maxFailures) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  return 0;
}

function bumpBucket(map: Map<string, RateBucket>, clientKey: string): void {
  const now = Date.now();
  pruneBuckets(map, now);
  const existing = map.get(clientKey);
  if (!existing || now >= existing.resetAt) {
    map.set(clientKey, {
      count: 1,
      resetAt: now + RATE_WINDOW_MS,
    });
  } else {
    existing.count += 1;
  }
}

export function getRateLimitRemainingSec(clientKey: string): number {
  return getBucketWaitSec(authFailureBuckets, clientKey, RATE_MAX_AUTH_FAILURES);
}

export function recordAuthFailure(clientKey: string): void {
  bumpBucket(authFailureBuckets, clientKey);
}

export function clearAuthFailures(clientKey: string): void {
  authFailureBuckets.delete(clientKey);
}

export function getWebhookRateLimitSec(clientKey: string): number {
  return getBucketWaitSec(webhookFailureBuckets, clientKey, RATE_MAX_WEBHOOK_FAILURES);
}

export function recordWebhookFailure(clientKey: string): void {
  bumpBucket(webhookFailureBuckets, clientKey);
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
