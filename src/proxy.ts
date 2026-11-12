import { NextResponse, type NextRequest } from "next/server";

/**
 * Same-origin guard for the local API (Next 16 "proxy", the former middleware).
 *
 * The server only listens on loopback, but any web page open in the user's browser can
 * still `fetch("http://127.0.0.1:3000/api/books", { method: "DELETE", mode: "no-cors" })`.
 * Browsers always attach `Origin` to such cross-site requests (and `Sec-Fetch-Site:
 * cross-site`), while the Electron window and a tab on the app's own origin send an
 * `Origin` equal to the server's own origin, or none at all (same-origin GETs, curl).
 *
 * Rule: for every non-safe method, and for the GETs that return sensitive data, an
 * `Origin` header must equal `<scheme>://<Host header>`; `Sec-Fetch-Site: cross-site`
 * is rejected outright. No tokens; loopback only.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSensitiveGet(request: NextRequest): boolean {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/api/debug/chat-logs") return true;
  if (pathname === "/api/share" && !searchParams.get("token")) return true;
  return false;
}

export function proxy(request: NextRequest) {
  const method = request.method.toUpperCase();
  const needsCheck = !SAFE_METHODS.has(method) || isSensitiveGet(request);
  if (!needsCheck) return NextResponse.next();

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host") || "";
    const proto = new URL(request.url).protocol; // "http:" / "https:"
    const self = `${proto}//${host}`.toLowerCase();
    if (!host || origin.toLowerCase() !== self) {
      return NextResponse.json({ error: "Origin does not match this server." }, { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
