import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

const STARTED_AT = new Date().toISOString();

function getVersion(): string {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function toDisplayVersion(version: string): string {
  const [majorRaw, minorRaw, patchRaw] = version.split(".");
  const major = Number(majorRaw || 0);
  const minor = Number(minorRaw || 0);
  const patch = Number(patchRaw || 0);
  // Human-friendly style requested by user: v0,23 / v1,07, etc.
  return `v${major},${minor}${patch}`;
}

function makeBuildId(version: string): string {
  const compact = STARTED_AT.replace(/[-:TZ.]/g, "").slice(2, 12);
  return `v${version}-b${compact}`;
}

export async function GET() {
  const version = getVersion();
  const buildId = makeBuildId(version);
  return NextResponse.json({
    version,
    displayVersion: toDisplayVersion(version),
    buildId,
    latestLabel: `LATEST BUILD • v${version} • ${buildId}`,
    startedAt: STARTED_AT,
  });
}
