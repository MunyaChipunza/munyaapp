import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
  context?: {
    deploy?: {
      context?: string;
    };
  };
};

type TaskLink = {
  url: string;
  label: string;
};

type IntakeTask = {
  id: string;
  title: string;
  list: string;
  dueDate: string | null;
  priority: string | null;
  done: false;
  notes: string;
  createdAt: string;
  updatedAt: string;
  source: "ai";
  sourceKey: string;
  links?: TaskLink[];
};

type IntakeState = {
  schemaVersion: 1;
  updatedAt: string;
  items: IntakeTask[];
  consumedSourceKeys: string[];
};

type AuthResult =
  | { ok: true; email: string }
  | { ok: false; status: number; message: string };

type NotionRichText = {
  plain_text?: string;
  text?: {
    content?: string;
  };
};

type NotionBlock = {
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
};

const STORE_NAME = "munyaapp-task-intake";
const STATE_KEY = "queue";
const DEFAULT_ALLOWED_EMAILS = ["chipunzamunya@gmail.com", "engineering@hydrofire.co.za"];
const DEFAULT_GOOGLE_CLIENT_ID = "257963331893-p6dfkmmu8lsfqero0ct0nfanf9i3dgbj.apps.googleusercontent.com";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.appdata";
const DEFAULT_INTAKE_TOKEN_SHA256 = "0e948f959de7d1bc0cd22bcc8990fa9aded40dbc5e5aa67783dc76b128ad3bbd";
const DEFAULT_NOTION_INBOX_PAGE_ID = "39014308-1ff0-8146-80bb-d18f4d9c48fc";
const NOTION_VERSION = "2022-06-28";
const VALID_LISTS = ["HydroFire", "Personal", "Family", "Zimbabwe", "Career", "Legal"];
const VALID_PRIORITIES = ["low", "medium", "high"];

export default async (req: Request) => {
  try {
    if (req.method === "GET") return handleGet(req);
    if (req.method === "POST") return handlePost(req);
    return textResponse("Method not allowed", 405);
  } catch (error) {
    console.error("Task intake function failed", error);
    return jsonResponse({ error: "Task intake function failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/task-intake",
};

async function handleGet(req: Request) {
  const auth = await verifyGoogleWrite(req);
  if (!auth.ok) return jsonResponse({ error: auth.message }, auth.status);

  let imported = { added: 0, skipped: false };
  try {
    imported = await importNotionInbox();
  } catch (error) {
    console.error("Notion intake import failed", error);
    imported = { added: 0, skipped: true };
  }
  const state = await getState();
  return jsonResponse({
    ok: true,
    tasks: state.items,
    count: state.items.length,
    importedFromNotion: imported.added,
    updatedAt: state.updatedAt,
  });
}

async function handlePost(req: Request) {
  const payload = await req.json().catch(() => null);
  if (payload?.action === "ack") {
    const auth = await verifyGoogleWrite(req);
    if (!auth.ok) return jsonResponse({ error: auth.message }, auth.status);
    const ids = Array.isArray(payload.ids) ? payload.ids.map(stringField).filter(Boolean) : [];
    const result = await ackTasks(ids);
    return jsonResponse({ ok: true, ...result });
  }

  const auth = verifyIntakeToken(req);
  if (!auth.ok) return jsonResponse({ error: auth.message }, auth.status);

  const rawTasks: unknown[] = Array.isArray(payload?.tasks) ? payload.tasks : [payload];
  const now = new Date().toISOString();
  const tasks = rawTasks
    .map((task: unknown, index: number) => normalizePostedTask(task, now, index))
    .filter((task): task is IntakeTask => Boolean(task));

  if (!tasks.length) {
    return jsonResponse({ error: "Expected at least one task with a title." }, 400);
  }

  const result = await enqueueTasks(tasks);
  return jsonResponse({ ok: true, ...result });
}

async function importNotionInbox() {
  const token = notionToken();
  const pageId = notionInboxPageId();
  if (!token || !pageId) return { added: 0, skipped: true };

  const state = await getState();
  const knownSourceKeys = new Set([
    ...state.items.map((task) => task.sourceKey),
    ...state.consumedSourceKeys,
  ]);
  const blocks = await listNotionChildren(pageId, token);
  const now = new Date().toISOString();
  const tasks: IntakeTask[] = [];

  for (const block of blocks) {
    const sourceKey = `notion:block:${block.id}`;
    if (!block.id || knownSourceKeys.has(sourceKey)) continue;
    const line = notionBlockText(block);
    const task = parseIntakeLine(line, sourceKey, now);
    if (task) tasks.push(task);
  }

  if (!tasks.length) return { added: 0, skipped: false };
  const result = await enqueueTasks(tasks, state);
  return { added: result.added, skipped: false };
}

async function enqueueTasks(tasks: IntakeTask[], existingState?: IntakeState) {
  const state = existingState || await getState();
  const seenIds = new Set(state.items.map((task) => task.id));
  const seenSourceKeys = new Set([
    ...state.items.map((task) => task.sourceKey),
    ...state.consumedSourceKeys,
  ]);
  let added = 0;

  tasks.forEach((task) => {
    if (seenIds.has(task.id) || seenSourceKeys.has(task.sourceKey)) return;
    state.items.push(task);
    seenIds.add(task.id);
    seenSourceKeys.add(task.sourceKey);
    added++;
  });

  state.updatedAt = new Date().toISOString();
  await saveState(state);
  return { added, pending: state.items.length, tasks: state.items };
}

async function ackTasks(ids: string[]) {
  const state = await getState();
  const ackIds = new Set(ids);
  const consumed = new Set(state.consumedSourceKeys);
  let acknowledged = 0;

  state.items = state.items.filter((task) => {
    if (!ackIds.has(task.id)) return true;
    consumed.add(task.sourceKey);
    acknowledged++;
    return false;
  });
  state.consumedSourceKeys = Array.from(consumed).slice(-2000);
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  return { acknowledged, pending: state.items.length };
}

async function getState() {
  const state = await getIntakeStore().get(STATE_KEY, { type: "json" }) as IntakeState | null;
  if (state?.schemaVersion === 1 && Array.isArray(state.items)) {
    return {
      schemaVersion: 1,
      updatedAt: state.updatedAt || new Date().toISOString(),
      items: state.items,
      consumedSourceKeys: Array.isArray(state.consumedSourceKeys) ? state.consumedSourceKeys : [],
    } satisfies IntakeState;
  }
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items: [],
    consumedSourceKeys: [],
  } satisfies IntakeState;
}

async function saveState(state: IntakeState) {
  await getIntakeStore().setJSON(STATE_KEY, state);
}

function getIntakeStore() {
  const storeName = Netlify.context?.deploy?.context === "production"
    ? STORE_NAME
    : `${STORE_NAME}-preview`;
  return getStore({ name: storeName, consistency: "strong" });
}

function normalizePostedTask(raw: unknown, now: string, index: number) {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const title = stringField(input.title || input.name || input.task);
  if (!title) return null;
  const sourceKey = stringField(input.sourceKey) || `api:${now}:${index}:${title}`;
  return makeTask({
    title,
    dueDate: dateField(input.dueDate || input.due || input.date),
    list: normalizeList(input.list || input.domain || input.tag),
    priority: normalizePriority(input.priority),
    notes: stringField(input.notes || input.note),
    links: normalizeLinks(input.links),
    sourceKey,
    now,
    id: stringField(input.id) || taskIdFromSource(sourceKey),
  });
}

function parseIntakeLine(raw: string, sourceKey: string, now: string) {
  const hasTaskPrefix = /^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s+)?(?:todo|task)\s*:\s*/i.test(raw);
  let line = raw
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\[[ xX]\]\s+/, "")
    .replace(/^\s*(todo|task)\s*:\s*/i, "")
    .trim();
  if (!line || (!line.includes("|") && !hasTaskPrefix) || /^task title\b/i.test(line) || /^allowed\b/i.test(line)) return null;

  const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
  const title = parts.shift() || "";
  if (!title || title.length < 2) return null;

  const fields = new Map<string, string>();
  parts.forEach((part) => {
    const match = part.match(/^([a-z ]+)\s*:\s*(.+)$/i);
    if (match) fields.set(match[1].toLowerCase().replace(/\s+/g, ""), match[2].trim());
  });

  return makeTask({
    title,
    dueDate: dateField(fields.get("due") || fields.get("duedate") || fields.get("date")),
    list: normalizeList(fields.get("list") || fields.get("domain") || fields.get("tag")),
    priority: normalizePriority(fields.get("priority")),
    notes: fields.get("notes") || fields.get("note") || "",
    links: normalizeLinks((fields.get("links") || fields.get("link") || "").split(",").map((url) => url.trim()).filter(Boolean)),
    sourceKey,
    now,
    id: taskIdFromSource(sourceKey),
  });
}

function makeTask(input: {
  title: string;
  dueDate: string | null;
  list: string;
  priority: string | null;
  notes: string;
  links: TaskLink[];
  sourceKey: string;
  now: string;
  id: string;
}) {
  const task: IntakeTask = {
    id: input.id,
    title: input.title.trim(),
    list: input.list,
    dueDate: input.dueDate,
    priority: input.priority,
    done: false,
    notes: input.notes.trim(),
    createdAt: input.now,
    updatedAt: input.now,
    source: "ai",
    sourceKey: input.sourceKey,
  };
  if (input.links.length) task.links = input.links;
  return task;
}

async function listNotionChildren(pageId: string, token: string) {
  const blocks: NotionBlock[] = [];
  let startCursor = "";
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
    url.searchParams.set("page_size", "100");
    if (startCursor) url.searchParams.set("start_cursor", startCursor);
    const response = await notionRequest(token, url.toString(), { method: "GET" });
    const data = await response.json() as { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string | null };
    blocks.push(...(data.results || []));
    startCursor = data.has_more && data.next_cursor ? data.next_cursor : "";
  } while (startCursor);
  return blocks;
}

async function notionRequest(token: string, url: string, init: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      ...(init.headers || {}),
    },
  });

  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after") || 1);
    await sleep(Math.max(1, retryAfter) * 1000);
    return notionRequest(token, url, init, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Notion API ${response.status}: ${text.slice(0, 500)}`);
  }
  return response;
}

function notionBlockText(block: NotionBlock) {
  const type = block.type || "";
  if (!["to_do", "bulleted_list_item", "paragraph"].includes(type)) return "";
  const value = block[type];
  if (!value || typeof value !== "object") return "";
  if (type === "to_do" && (value as Record<string, unknown>).checked === true) return "";
  const richText = (value as Record<string, unknown>).rich_text;
  if (!Array.isArray(richText)) return "";
  return richTextPlain(richText as NotionRichText[]);
}

function richTextPlain(richText: NotionRichText[]) {
  return richText.map((text) => text.plain_text || text.text?.content || "").join("").trim();
}

async function verifyGoogleWrite(req: Request): Promise<AuthResult> {
  const configuredAllowedEmails = csvEnv("TASKS_ALLOWED_EMAILS");
  const allowedEmails = (configuredAllowedEmails.length ? configuredAllowedEmails : DEFAULT_ALLOWED_EMAILS)
    .map((email) => email.toLowerCase());
  if (!allowedEmails.length) {
    return { ok: false, status: 500, message: "TASKS_ALLOWED_EMAILS is not configured." };
  }

  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, message: "Missing Google access token." };
  }

  const token = auth.slice(7).trim();
  const tokenInfo = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!tokenInfo.ok) {
    return { ok: false, status: 401, message: "Google access token could not be verified." };
  }

  const info = await tokenInfo.json() as Record<string, unknown>;
  const expectedClientId = env("TASKS_GOOGLE_CLIENT_ID") || DEFAULT_GOOGLE_CLIENT_ID;
  if (expectedClientId && stringField(info.aud) !== expectedClientId) {
    return { ok: false, status: 403, message: "Google token audience does not match this app." };
  }

  const scopes = stringField(info.scope).split(/\s+/).filter(Boolean);
  const hasAppScope = GCAL_SCOPE.split(/\s+/).some((scope) => scopes.includes(scope));
  if (!hasAppScope) {
    return { ok: false, status: 403, message: "Google token does not include Munya App sync scopes." };
  }

  const email = stringField(info.email).toLowerCase();
  if (email && !allowedEmails.includes(email)) {
    return { ok: false, status: 403, message: "Google account is not allowed to import task intake." };
  }
  return { ok: true, email: email || "google-token" };
}

function verifyIntakeToken(req: Request): AuthResult {
  const configuredToken = env("TASK_INTAKE_TOKEN");
  const configuredTokenHash = env("TASK_INTAKE_TOKEN_SHA256") || DEFAULT_INTAKE_TOKEN_SHA256;
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const suppliedToken = url.searchParams.get("token") ||
    req.headers.get("x-task-intake-token") ||
    bearer;

  if (suppliedToken && configuredToken && suppliedToken === configuredToken) {
    return { ok: true, email: "claude" };
  }
  if (suppliedToken && configuredTokenHash && sha256Hex(suppliedToken) === configuredTokenHash) {
    return { ok: true, email: "claude" };
  }
  return { ok: false, status: 401, message: "Missing or invalid task intake token." };
}

function normalizeList(raw: unknown) {
  const value = stringField(raw);
  if (!value) return "HydroFire";
  const exact = VALID_LISTS.find((item) => item.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  if (/work|hydro/i.test(value)) return "HydroFire";
  if (/home|family|marriage/i.test(value)) return "Family";
  if (/zim|estate|tapera/i.test(value)) return "Zimbabwe";
  if (/career|job|book|mba|study/i.test(value)) return "Career";
  if (/legal|law|lawyer/i.test(value)) return "Legal";
  if (/personal|life|admin/i.test(value)) return "Personal";
  return "HydroFire";
}

function normalizePriority(raw: unknown) {
  const value = stringField(raw).toLowerCase();
  return VALID_PRIORITIES.includes(value) ? value : null;
}

function normalizeLinks(raw: unknown) {
  const items = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  return items.map((link) => {
    const input: Record<string, unknown> = typeof link === "object" && link
      ? link as Record<string, unknown>
      : { url: link };
    const url = normalizeLinkUrl(input.url || input.href);
    if (!url || seen.has(url)) return null;
    seen.add(url);
    return {
      url,
      label: stringField(input.label || input.title) || "Link",
    };
  }).filter((link): link is TaskLink => Boolean(link));
}

function normalizeLinkUrl(value: unknown) {
  let url = stringField(value).replace(/[.,!?;:)\]}]+$/, "");
  if (!url) return "";
  if (/^www\./i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function dateField(value: unknown) {
  const text = stringField(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function taskIdFromSource(sourceKey: string) {
  return `claude-${sha256Hex(sourceKey).slice(0, 20)}`;
}

function env(key: string) {
  return Netlify.env.get(key)?.trim() || process.env[key]?.trim() || "";
}

function csvEnv(key: string) {
  return env(key).split(",").map((value) => value.trim()).filter(Boolean);
}

function notionToken() {
  return base64Env("MUNYA_NOTION_BRIDGE_B64") ||
    env("MUNYA_NOTION_BRIDGE") ||
    env("LIVE_TASKS_NOTION_TOKEN") ||
    env("NOTION_TOKEN") ||
    env("TASKS_NOTION_TOKEN");
}

function base64Env(key: string) {
  const value = env(key);
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

function notionInboxPageId() {
  return env("NOTION_TASK_INBOX_PAGE_ID") || DEFAULT_NOTION_INBOX_PAGE_ID;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}
