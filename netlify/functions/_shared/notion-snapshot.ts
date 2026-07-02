import type { DashboardPayload } from "./finance-transformer.js";
import { getEnv } from "./env.js";
import { readBlobValue, writeBlobValue } from "./finance-cache.js";

const NOTION_VERSION = "2022-06-28";
const SNAPSHOT_TITLE = "Family Finance Live Dashboard - Current";
const PAGE_ID_BLOB_KEY = "notion-current-page-id";

type NotionBlock = Record<string, unknown>;

function notionHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function textBlock(type: "paragraph" | "heading_1" | "heading_2" | "heading_3", text: string): NotionBlock {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
    },
  };
}

function bullet(text: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
    },
  };
}

async function notionRequest(token: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      ...notionHeaders(token),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Notion API ${path} failed with HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function resolveSnapshotPageId(token: string): Promise<string | null> {
  const explicit = getEnv("NOTION_SNAPSHOT_PAGE_ID");
  if (explicit) return explicit;

  const cached = await readBlobValue<{ pageId?: string }>(PAGE_ID_BLOB_KEY);
  if (cached?.pageId) return cached.pageId;

  const parentPageId = getEnv("NOTION_SNAPSHOT_PARENT_PAGE_ID");
  if (!parentPageId) return null;

  const created = await notionRequest(token, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: SNAPSHOT_TITLE } }],
        },
      },
    }),
  });
  const pageId = String(created.id ?? "");
  if (!pageId) throw new Error("Notion page creation succeeded but returned no page id.");
  await writeBlobValue(PAGE_ID_BLOB_KEY, { pageId });
  return pageId;
}

async function clearChildren(token: string, pageId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const result = await notionRequest(token, `/blocks/${pageId}/children?${params.toString()}`);
    const blocks = Array.isArray(result.results) ? (result.results as Record<string, unknown>[]) : [];
    for (const block of blocks) {
      if (block.id) {
        await notionRequest(token, `/blocks/${block.id}`, {
          method: "PATCH",
          body: JSON.stringify({ archived: true }),
        });
      }
    }
    cursor = result.has_more ? String(result.next_cursor) : undefined;
  } while (cursor);
}

function summaryValue(payload: DashboardPayload, label: string): string {
  const cards = Array.isArray(payload.summaryCards) ? (payload.summaryCards as Record<string, unknown>[]) : [];
  const card = cards.find((item) => item.label === label);
  return String(card?.value ?? "-");
}

function snapshotBlocks(payload: DashboardPayload): NotionBlock[] {
  const focusItems = Array.isArray(payload.focusItems) ? (payload.focusItems as Record<string, unknown>[]) : [];
  const watchlistRows = Array.isArray(payload.watchlistRows) ? (payload.watchlistRows as Record<string, unknown>[]) : [];
  const decisionRows = Array.isArray(payload.decisionRows) ? (payload.decisionRows as Record<string, unknown>[]) : [];

  return [
    textBlock("heading_1", SNAPSHOT_TITLE),
    textBlock("paragraph", `Report month: ${String(payload.reportMonth ?? "-")} | Generated: ${String(payload.generatedAt ?? "-")} | Source updated: ${String(payload.sourceUpdatedAt ?? "-")}`),
    textBlock("paragraph", `Mode: ${String(payload.dataMode ?? "-")} | Health: ${String((payload.health as Record<string, unknown> | undefined)?.label ?? "-")} (${String(payload.healthScore ?? "-")}/100)`),
    textBlock("heading_2", "Board Summary"),
    bullet(`Income: ${summaryValue(payload, "Take-home Income")}`),
    bullet(`Outflows: ${summaryValue(payload, "Monthly Outflows")}`),
    bullet(`Net Position: ${summaryValue(payload, "Net Position")}`),
    bullet(`Cash Buffer: ${summaryValue(payload, "Cash Buffer") || summaryValue(payload, "Liquid Cash")}`),
    bullet(`Net Worth: ${summaryValue(payload, "Net Worth")}`),
    textBlock("heading_2", "Executive Summary"),
    textBlock("paragraph", String(payload.executiveSummary ?? "")),
    textBlock("heading_2", "Focus"),
    ...focusItems.slice(0, 6).map((item) => bullet(`${String(item.title ?? "-")}: ${String(item.detail ?? "")}`)),
    textBlock("heading_2", "Risk Watchlist"),
    ...watchlistRows.slice(0, 8).map((item) => bullet(`${String(item.item ?? "-")} - ${String(item.metric ?? "-")}: ${String(item.action ?? "")}`)),
    textBlock("heading_2", "Decisions"),
    ...decisionRows.slice(0, 6).map((item) => bullet(`${String(item.title ?? "-")} (${String(item.timeframe ?? "-")}): ${String(item.detail ?? "")}`)),
  ].slice(0, 90);
}

export async function syncNotionSnapshot(payload: DashboardPayload): Promise<{ skipped: boolean; pageId?: string }> {
  const token = getEnv("NOTION_TOKEN");
  if (!token) return { skipped: true };

  const pageId = await resolveSnapshotPageId(token);
  if (!pageId) return { skipped: true };

  await clearChildren(token, pageId);
  await notionRequest(token, `/blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children: snapshotBlocks(payload) }),
  });
  return { skipped: false, pageId };
}
