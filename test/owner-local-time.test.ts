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

  it("resolves the real Codex bot personas once they are in the canonical tenant_map (ALB-1201 finding 1: albert-v3=Theo, albert-codex-e2e=Ada)", () => {
    // Regression guard for Theo's runtime RED: before the canonical
    // tenant_map.json carried these personas, MAILBOX_PERSONA=albert-v3 hit the
    // persona-as-tenant fallback (no albert-v3.json) and returned null, so
    // owner-local-time silently no-op'd on the live Theo/Ada runtimes. With the
    // personas mapped to the owner they resolve to the owner's location.
    const baseDir = fixtureDir({
      "tenant_map.json": JSON.stringify({ "albert-v3": "albert", "albert-codex-e2e": "albert" }),
      "albert.json": JSON.stringify({ lat: 39.193581, lng: 9.160067, ts: "2026-07-11T12:34:33+00:00" }),
      "tz_cache.json": JSON.stringify({ "39.2,9.2": "Europe/Rome" }),
    });

    for (const persona of ["albert-v3", "albert-codex-e2e"]) {
      const line = resolveOwnerLocalTimeLine({ baseDir, persona, now: NOW });
      expect(line, persona).not.toBeNull();
      expect(line, persona).toContain("Europe/Rome");
      expect(line, persona).toContain("2026-07-12 10:22");
    }
  });

  it("maps every ALB-1201 rollout persona to the owner in the REAL canonical tenant_map (Theo Important 1: six-persona coverage)", () => {
    // Real-data regression (no baseDir -> the live shared owner_location dir).
    // Theo's rollout-gate RED: albert-v3/albert-codex-e2e resolved but the four
    // codex-testbot personas returned null. Deployment is Testbot -> Theo -> Ada,
    // so every rollout target must resolve. Compared against an already-mapped
    // owner persona (cody) so the guard is robust to the owner's live location
    // instead of pinning a specific timezone.
    const rolloutPersonas = [
      "albert-v3",
      "albert-codex-e2e",
      "codex-testbot",
      "codex-testbot-2",
      "codex-testbot-3",
      "codex-testbot-4",
    ];
    const baseline = resolveOwnerLocalTimeLine({ persona: "cody", now: NOW });
    expect(baseline, "cody baseline should resolve from real canonical data").not.toBeNull();
    for (const persona of rolloutPersonas) {
      expect(resolveOwnerLocalTimeLine({ persona, now: NOW }), persona).toBe(baseline);
    }
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
