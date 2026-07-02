import type { Config, Context } from "@netlify/functions";
import { getFinanceDashboard } from "./_shared/finance-service.js";

function jsonResponse(payload: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Netlify-CDN-Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Pragma: "no-cache",
      Expires: "0",
      ...extraHeaders,
    },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  try {
    const result = await getFinanceDashboard();
    return jsonResponse(result.payload, 200, {
      "X-Finance-Dashboard-Source": result.source,
      ...(result.warning ? { "X-Finance-Dashboard-Warning": result.warning.slice(0, 500) } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        error: "Finance dashboard data is unavailable.",
        detail: message,
        stale: true,
        fallback: null,
      },
      503,
      { "X-Finance-Dashboard-Source": "error" },
    );
  }
};

export const config: Config = {
  path: "/api/finance-dashboard",
};
