import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Read-only demo mode (OPENVAULT_DEMO=1).
//
// A public demo has two bad options without this: keep the password secret and
// nobody can look around, or publish it and every visitor is an owner who can
// delete the vault. Demo mode is the third: anyone may READ, nobody may WRITE.
//
// Enforced here rather than route by route, deliberately. This denies every
// mutating request by default, so a route added later is safe without anyone
// remembering to guard it — the opposite of an allowlist that rots.
//
// /api/mcp is exempt at this layer because agents read over POST; its write
// TOOLS are blocked inside the route, where tool names are known.
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT = ["/api/mcp", "/api/auth"];

export function proxy(request: NextRequest) {
  if (process.env.OPENVAULT_DEMO !== "1") return NextResponse.next();
  if (READ_ONLY_METHODS.has(request.method)) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();

  return NextResponse.json(
    {
      error: "read_only_demo",
      details:
        "This is a public read-only demo of OpenVault. Browse anything; nothing can be changed. Self-host to get a writable vault: https://github.com/fangiskhan/openvault",
    },
    { status: 403 },
  );
}

export const config = {
  // Only API routes mutate; pages are read-only by nature.
  matcher: "/api/:path*",
};
