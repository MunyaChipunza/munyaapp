import type { DashboardPayload } from "./finance-transformer.js";
import { buildDashboardFromSheetValues } from "./finance-transformer.js";
import { fetchFinanceSheetValues } from "./google-sheets.js";
import { readSnapshot, writeSnapshot } from "./finance-cache.js";
import { syncNotionSnapshot } from "./notion-snapshot.js";

export interface FinanceResult {
  payload: DashboardPayload;
  source: "google-sheets" | "blob-fallback";
  warning?: string;
}

function fallbackPayload(payload: DashboardPayload, reason: unknown, cachedAt: string): DashboardPayload {
  const message = reason instanceof Error ? reason.message : String(reason);
  return {
    ...payload,
    stale: true,
    servedAt: new Date().toISOString(),
    dataMode: "Cached snapshot",
    dataQuality: {
      label: "Cached snapshot",
      tone: "warn",
      detail: `Live Google Sheets refresh failed, so this response is the latest successful Netlify Blob snapshot cached at ${cachedAt}. Reason: ${message}`,
    },
    fallback: {
      source: "netlify-blobs",
      cachedAt,
      failedAt: new Date().toISOString(),
      reason: message,
    },
  };
}

export async function refreshFinanceSnapshot(): Promise<FinanceResult> {
  const cached = await readSnapshot();
  const sheet = await fetchFinanceSheetValues();
  const payload = buildDashboardFromSheetValues(sheet.values, {
    sourceName: sheet.sourceName,
    sourceUpdatedAt: sheet.sourceUpdatedAt,
    existingHistory: Array.isArray(cached?.payload.history) ? (cached?.payload.history as Record<string, unknown>[]) : [],
  });
  await writeSnapshot(payload);
  await syncNotionSnapshot(payload);
  return { payload, source: "google-sheets" };
}

export async function getFinanceDashboard(): Promise<FinanceResult> {
  try {
    return await refreshFinanceSnapshot();
  } catch (error) {
    const cached = await readSnapshot();
    if (!cached) throw error;
    return {
      payload: fallbackPayload(cached.payload, error, cached.cachedAt),
      source: "blob-fallback",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
