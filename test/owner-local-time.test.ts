import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OWNER_LOCAL_TIME_PREFIX,
  resolveOwnerLocalTimeLine,
} from "../src/owner-local-time.js";

const dirs: string[] = [];

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "owner-loc-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents, "utf-8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-07-12T08:22:00Z is 10:22 in Europe/Rome (CEST, UTC+2) and a Sunday.
const NOW = new Date("2026-07-12T08:22:00Z");

describe("resolveOwnerLocalTimeLine", () => {
  it("resolves persona -> tenant -> coords -> tz_cache into a local-time line", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "albert.json": JSON.stringify({ lat: 39.193581, lng: 9.160067, ts: "2026-07-11T12:34:33+00:00" }),
      "tz_cache.json": JSON.stringify({ "39.2,9.2": "Europe/Rome" }),
    });

    const line = resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW });

    expect(line).not.toBeNull();
    expect(line!.startsWith(OWNER_LOCAL_TIME_PREFIX)).toBe(true);
    expect(line).toContain("Europe/Rome");
    expect(line).toContain("2026-07-12 10:22");
    expect(line).toMatch(/\((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\)$/);
    expect(line).toContain("(Sun)");
  });

  it("falls back to treating the persona itself as the tenant when the map has no entry", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ someoneElse: "other" }),
      "cody.json": JSON.stringify({ lat: 48.9, lng: 2.3 }),
      "tz_cache.json": JSON.stringify({ "48.9,2.3": "Europe/Paris" }),
    });

    const line = resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW });

    expect(line).not.toBeNull();
    expect(line).toContain("Europe/Paris");
  });

  it("uses a tenant-specific manual override file when coords do not resolve", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      // No albert.json / tz_cache hit; manual file must win.
      "albert_timezone.txt": "Asia/Tokyo\n",
    });

    const line = resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW });

    expect(line).not.toBeNull();
    expect(line).toContain("Asia/Tokyo");
  });

  it("uses the generic owner_timezone.txt manual override when present", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "owner_timezone.txt": "America/New_York\n",
    });

    const line = resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW });

    expect(line).not.toBeNull();
    expect(line).toContain("America/New_York");
  });

  it("prefers the coords cache over the manual file (coords-first precedence)", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "albert.json": JSON.stringify({ lat: 39.2, lng: 9.2 }),
      "tz_cache.json": JSON.stringify({ "39.2,9.2": "Europe/Rome" }),
      "albert_timezone.txt": "Asia/Tokyo\n",
    });

    const line = resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW });

    expect(line).toContain("Europe/Rome");
    expect(line).not.toContain("Asia/Tokyo");
  });

  it("returns null when nothing resolves (no fabricated fallback)", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "albert.json": JSON.stringify({ lat: 12.34, lng: 56.78 }),
      "tz_cache.json": JSON.stringify({ "0.0,0.0": "Europe/Rome" }),
    });

    expect(resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW })).toBeNull();
  });

  it("returns null when the location dir is empty", () => {
    const baseDir = fixtureDir({});
    expect(resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW })).toBeNull();
  });

  it("returns null (never throws) on malformed JSON files", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": "{ this is not json",
      "albert.json": "also broken",
      "tz_cache.json": "}}}",
    });

    expect(resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW })).toBeNull();
  });

  it("returns null when persona is empty", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "albert.json": JSON.stringify({ lat: 39.2, lng: 9.2 }),
      "tz_cache.json": JSON.stringify({ "39.2,9.2": "Europe/Rome" }),
    });

    expect(resolveOwnerLocalTimeLine({ baseDir, persona: "", now: NOW })).toBeNull();
  });

  it("ignores an invalid IANA name in the manual override", () => {
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ cody: "albert" }),
      "owner_timezone.txt": "Not/A_Real_Zone_Xyz\n",
    });

    expect(resolveOwnerLocalTimeLine({ baseDir, persona: "cody", now: NOW })).toBeNull();
  });
});
