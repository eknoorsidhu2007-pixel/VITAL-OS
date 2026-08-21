import { NextResponse, type NextRequest } from "next/server";

import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth token on every matched request.
 *
 * Next 14 uses `middleware.ts`. The current Supabase docs show `proxy.ts` with
 * an exported `proxy` function — that is the Next 16 convention and is silently
 * ignored here.
 *
 * This middleware deliberately performs no redirects: `AppGate` gates the UI
 * client-side, and a server-side redirect would race it. Its only job is to
 * keep the access token fresh and hand the refreshed cookies to both the
 * server (via `request.cookies`) and the browser (via `response.cookies`).
 *
 * Doctor-only API routes additionally check a custom clinical `role` claim
 * after the token refresh. The dashboard and static assets are not blocked.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without Supabase configured there is no session to refresh. Fall through
  // rather than throwing — a misconfigured env should not 500 every route.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // Cache-Control: private, no-store and friends. A cached Set-Cookie
        // response would serve one clinician's session to the next visitor.
        for (const [header, headerValue] of Object.entries(headers)) {
          response.headers.set(header, headerValue);
        }
      },
    },
  });

  // Verifies the JWT signature against the project's published keys, unlike
  // getSession(), whose user object must not be trusted in server code.
  const { data: claimsData } = await supabase.auth.getClaims();

  /**
   * Returns a 403 when the JWT's custom clinical `role` claim is missing or
   * not listed in `allowedRoles`. Otherwise returns null (caller continues).
   *
   * Clinical role lives in `user_metadata.role` (set at account creation).
   * The top-level JWT `role` claim is Supabase's auth role (`authenticated`)
   * and is ignored unless it is itself a clinical role (doctor|staff) from a
   * Custom Access Token Hook.
   */
  function requireRole(allowedRoles: string[]): NextResponse | null {
    const claims = claimsData?.claims as Record<string, unknown> | undefined;
    const role = readClinicalRoleClaim(claims);

    if (!role || !allowedRoles.includes(role)) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      );
    }

    return null;
  }

  const pathname = request.nextUrl.pathname;
  if (pathname === "/api/vital" || pathname === "/api/transcribe") {
    const denied = requireRole(["doctor"]);
    if (denied) return denied;
  }

  return response;
}

function readClinicalRoleClaim(
  claims: Record<string, unknown> | undefined
): string | null {
  if (!claims) return null;

  const fromMeta = (meta: unknown): string | null => {
    if (!meta || typeof meta !== "object") return null;
    const role = (meta as { role?: unknown }).role;
    return typeof role === "string" && role.trim() ? role.trim() : null;
  };

  const fromUserMeta = fromMeta(claims.user_metadata);
  if (fromUserMeta) return fromUserMeta;

  const fromAppMeta = fromMeta(claims.app_metadata);
  if (fromAppMeta) return fromAppMeta;

  // Only accept a top-level role when it is a clinical value, not Supabase's
  // built-in "authenticated" / "anon" / "service_role".
  const topLevel = claims.role;
  if (
    typeof topLevel === "string" &&
    (topLevel === "doctor" || topLevel === "staff")
  ) {
    return topLevel;
  }

  return null;
}

export const config = {
  matcher: [
    /*
     * Every path except static assets and image files. Auth cookies are needed
     * on page routes and API routes alike.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
