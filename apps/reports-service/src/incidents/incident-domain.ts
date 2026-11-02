import { createHash } from "node:crypto";

export const PIPELINE = "incidents-v1";
export const CLUSTER_LOCK = 20261101;
export const STATUSES = [
  "DETECTED",
  "UNDER_REVIEW",
  "VERIFIED",
  "RESCUE_DEPLOYED",
  "RESOLVED",
] as const;
export const SEVERITIES = [
  "UNKNOWN",
  "LOW",
  "MODERATE",
  "HIGH",
  "CRITICAL",
] as const;
export type Actor = { userId: number; role: string };
export type Sql = { query: (sql: string, values?: any[]) => Promise<any[]> };
export class IncidentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new IncidentError(status, code, message);
};
export function authorize(actor: Actor, admin = false) {
  if (!Number.isSafeInteger(actor?.userId) || actor.userId < 1)
    fail(401, "unauthorized", "Authentication required");
  if (!(admin ? ["admin"] : ["admin", "relief"]).includes(actor.role))
    fail(403, "forbidden", "Insufficient permissions");
}
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
export function urgent(report: {
  isUrgent?: unknown;
  category?: unknown;
  description?: unknown;
}): boolean {
  if (
    report.isUrgent === true ||
    report.isUrgent === "true" ||
    (Array.isArray(report.category) && report.category.includes("rescue"))
  )
    return true;
  return fold(typeof report.description === "string" ? report.description : "")
    .split(/[.!?;\n]/)
    .some((s) =>
      [
        ...s.matchAll(
          /\b(cuu voi|can cuu ho|can cuu tro|mac ket|duoi nuoc|nguy kich)\b/g,
        ),
      ].some((match) => {
        const parts = s
          .slice(0, match.index)
          .split(/,|\b(?:nhung|tuy nhien|va)\b/);
        const prefix = parts[parts.length - 1] ?? "";
        return !/\b(?:khong|chua|ko)(?:\s+(?:co|con|bi|ai|nguoi|xe|nao|tre|em|gia))*\s*$/.test(
          prefix,
        );
      }),
    );
}
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(
      /(?:tôi tên|toi ten|họ tên|ho ten|tên tôi|ten toi)\s*[:：]?\s*[^,;.\n]{1,60}/gi,
      "[tên đã ẩn]",
    )
    .replace(/(?:\+?84|0)[\s.-]?(?:\d[\s.-]?){8,10}\b/g, "[điện thoại]")
    .replace(/\b\d{9,12}\b/g, "[thông tin cá nhân]");
}
export function snapshot(report: object): Record<string, unknown> {
  const source = report as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of [
    "id",
    "description",
    "category",
    "province",
    "ward",
    "addressLine",
    "lat",
    "lng",
    "images",
    "evidences",
    "status",
    "isUrgent",
    "severity",
    "createdAt",
    "updatedAt",
  ])
    if (source[key] !== undefined) result[key] = source[key];
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export type CoordinatesInput = { lat?: unknown; lng?: unknown };
export function validCoordinates<T extends CoordinatesInput>(
  r: T,
): r is T & { lat: number; lng: number } {
  return (
    typeof r.lat === "number" &&
    typeof r.lng === "number" &&
    Number.isFinite(r.lat) &&
    Number.isFinite(r.lng) &&
    Math.abs(r.lat) <= 90 &&
    Math.abs(r.lng) <= 180
  );
}
export function distance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const rad = Math.PI / 180,
    dLat = (a.lat - b.lat) * rad,
    dLng = (a.lng - b.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function cosine(a: number[], b: number[]) {
  if (
    !a.length ||
    a.length !== b.length ||
    [...a, ...b].some((v) => !Number.isFinite(v))
  )
    return -1;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
export function centroid(vectors: number[][]) {
  if (!vectors.length) return [];
  const result = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors)
    for (let i = 0; i < result.length; i++)
      result[i] += vector[i] / vectors.length;
  return result;
}
export function matchingConfig() {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error("invalid_incident_configuration");
    return value;
  };
  return {
    radius: number("INCIDENT_RADIUS_METERS", 300, 10, 1000),
    gapHours: number("INCIDENT_GAP_HOURS", 6, 1, 24),
    spanHours: number("INCIDENT_SPAN_HOURS", 24, 1, 72),
    similarity: number("INCIDENT_SIMILARITY", 0.88, 0.7, 1),
    margin: number("INCIDENT_SIMILARITY_MARGIN", 0.05, 0.01, 0.3),
  };
}
export function geoTemporalMatch(
  report: CoordinatesInput & { createdAt: string | Date },
  incident: CoordinatesInput & {
    status: string;
    merged_into?: string | null;
    first_reported_at: string | Date;
    latest_reported_at: string | Date;
  },
  config = matchingConfig(),
) {
  if (
    !validCoordinates(report) ||
    !validCoordinates(incident) ||
    incident.status === "RESOLVED" ||
    incident.merged_into
  )
    return false;
  const timestamp = (value: string | Date) =>
    value instanceof Date ? value.getTime() : Date.parse(value);
  const at = timestamp(report.createdAt),
    first = timestamp(incident.first_reported_at),
    last = timestamp(incident.latest_reported_at);
  return (
    Number.isFinite(at) &&
    distance(report, incident) <= config.radius &&
    Math.max(0, at - last, first - at) <= config.gapHours * 3600000 &&
    Math.max(last, at) - Math.min(first, at) <= config.spanHours * 3600000
  );
}
export function checkStatus(
  actor: Actor,
  incident: { status: string; assignee_id: number | null },
  next: string,
) {
  authorize(actor);
  if (!STATUSES.includes(next as (typeof STATUSES)[number]))
    fail(400, "invalid_status", "Invalid incident status");
  if (next === "VERIFIED")
    fail(400, "use_verification", "Use the verification action");
  if (
    actor.role === "relief" &&
    (incident.assignee_id !== actor.userId ||
      !["RESCUE_DEPLOYED", "RESOLVED"].includes(next))
  )
    fail(
      403,
      "assignment_required",
      "Only the assigned relief account may update progress",
    );
  if (incident.status === "RESOLVED" && actor.role !== "admin")
    fail(
      403,
      "admin_reopen_required",
      "An administrator must reopen this incident",
    );
  if (next === "RESCUE_DEPLOYED" && !incident.assignee_id)
    fail(
      409,
      "assignment_required",
      "Assign a relief account before deployment",
    );
  if (
    actor.role === "relief" &&
    next === "RESOLVED" &&
    !["VERIFIED", "RESCUE_DEPLOYED"].includes(incident.status)
  )
    fail(
      409,
      "invalid_transition",
      "The incident must be verified or deployed first",
    );
}
export function page(query: { limit?: number | string; cursor?: string }) {
  const limit = Number(query.limit ?? 25);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail(400, "invalid_limit", "Limit must be between 1 and 100");
  let offset = 0;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString(),
      ) as { after?: unknown };
      if (typeof decoded.after !== "number")
        return fail(400, "invalid_cursor", "Invalid cursor");
      offset = decoded.after;
    } catch {
      fail(400, "invalid_cursor", "Invalid cursor");
    }
    if (!Number.isSafeInteger(offset) || offset < 0)
      fail(400, "invalid_cursor", "Invalid cursor");
  }
  return { limit, after: offset };
}
export function pageResult<T extends object>(
  items: T[],
  limit: number,
  key: (item: T) => number = (item) =>
    Number((item as Record<string, unknown>).id),
) {
  const more = items.length > limit,
    selected = items.slice(0, limit);
  return {
    items: selected,
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({ after: key(selected[selected.length - 1]) }),
        ).toString("base64url")
      : null,
  };
}
