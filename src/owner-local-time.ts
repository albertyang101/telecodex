import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * ALB-1201 owner-local-time resolver (telecodex parity with the CC recall_hook).
 *
 * When the bot tells the owner a time, it must use the OWNER's current local
 * timezone (wherever they actually are), never the machine/server clock. This
 * mirrors the precedence of the CC-side `_resolve_owner_tz` / `_coords_to_tz_name`
 * (tools/channels_hooks/recall_hook.py):
 *
 *   ① persona -> tenant (tenant_map.json) -> owner_location/<tenant>.json coords
 *      -> round each coord to 0.1 deg -> look "lat,lng" up in tz_cache.json
 *   ② manual override file: <tenant>_timezone.txt OR owner_timezone.txt
 *   ③ give up -> null (inject NO time line; never fabricate Melbourne)
 *
 * No new npm dependency: coords -> IANA reuses the shared tz_cache.json the CC
 * side already maintains (Node has no timezonefinder). Time formatting uses
 * Node's built-in Intl.DateTimeFormat (full ICU).
 *
 * Pure and injectable: baseDir / persona / now default to the real shared dir
 * and the real clock but are overridable for tests. All file reads are
 * defensive — missing/malformed files resolve to null, never throw.
 */

const DEFAULT_BASE_DIR = path.join(
  homedir(),
  "personas",
  "_shared",
  "channels-state",
  "owner_location",
);
const TENANT_MAP_FILE = "tenant_map.json";
const TZ_CACHE_FILE = "tz_cache.json";
const OWNER_TZ_MANUAL_FILE = "owner_timezone.txt";

/** Shared prefix so the echo-strip in prompt-guard can match the context line. */
export const OWNER_LOCAL_TIME_PREFIX = "Current time (owner local, ";

export interface ResolveOwnerLocalTimeOptions {
  /** Directory holding tenant_map.json / <tenant>.json / tz_cache.json / *_timezone.txt. */
  baseDir?: string;
  /** Running persona (MAILBOX_PERSONA). Defaults to process.env.MAILBOX_PERSONA. */
  persona?: string;
  /** Injectable "now" for deterministic tests. Defaults to the real clock. */
  now?: Date;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveTenant(baseDir: string, persona: string): string {
  const map = readJsonObject(path.join(baseDir, TENANT_MAP_FILE));
  const mapped = map?.[persona];
  if (typeof mapped === "string" && mapped.trim()) {
    return mapped.trim();
  }
  // Prefer the map, but fall back to treating the persona string as the tenant.
  return persona;
}

function coordsToTzName(baseDir: string, lat: number, lng: number): string | null {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  const cache = readJsonObject(path.join(baseDir, TZ_CACHE_FILE));
  const hit = cache?.[key];
  return typeof hit === "string" && hit.trim() ? hit.trim() : null;
}

function isValidIanaTz(tz: string): boolean {
  try {
    // Throws RangeError for an unknown time zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readManualTz(baseDir: string, tenant: string): string | null {
  for (const name of [`${tenant}_timezone.txt`, OWNER_TZ_MANUAL_FILE]) {
    let raw: string;
    try {
      raw = readFileSync(path.join(baseDir, name), "utf-8").trim();
    } catch {
      continue;
    }
    if (raw && isValidIanaTz(raw)) {
      return raw;
    }
  }
  return null;
}

function resolveOwnerTz(baseDir: string, persona: string): string | null {
  const tenant = resolveTenant(baseDir, persona);

  // ① coords cache first (mirrors CC recall_hook precedence).
  const loc = readJsonObject(path.join(baseDir, `${tenant}.json`));
  if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
    const tz = coordsToTzName(baseDir, loc.lat, loc.lng);
    if (tz && isValidIanaTz(tz)) {
      return tz;
    }
  }

  // ② manual override file.
  return readManualTz(baseDir, tenant);
}

function formatOwnerLocalTimeLine(tz: string, now: Date): string | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    const parts = dtf.formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const weekday = get("weekday");
    if (!year || !month || !day || !hour || !minute) {
      return null;
    }
    return `${OWNER_LOCAL_TIME_PREFIX}${tz}): ${year}-${month}-${day} ${hour}:${minute} (${weekday})`;
  } catch {
    return null;
  }
}

/**
 * Resolve the owner's current local-time line, or null if it cannot be
 * determined at any layer (never fabricates a fallback timezone).
 */
export function resolveOwnerLocalTimeLine(opts: ResolveOwnerLocalTimeOptions = {}): string | null {
  const persona = (opts.persona ?? process.env.MAILBOX_PERSONA ?? "").trim();
  if (!persona) {
    return null;
  }
  const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
  const now = opts.now ?? new Date();

  const tz = resolveOwnerTz(baseDir, persona);
  if (!tz) {
    return null;
  }
  return formatOwnerLocalTimeLine(tz, now);
}
