import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

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

type TaskSnapshotItem = {
  id: string;
  title: string;
  list: string;
  dueDate: string | null;
  priority: string | null;
  done: boolean;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
  doneAt?: string;
  deletedAt?: string;
  source?: string;
  sourceKey?: string;
  sourceEventId?: string;
  sourceCalendarId?: string;
  sourceCalendarName?: string;
  sourceStartDate?: string;
  sourceStartTime?: string;
  sourceEndTime?: string;
  sourceStartAt?: string;
  sourceEndAt?: string;
  sourceAllDay?: boolean;
  sourceNotes?: string;
  links?: TaskLink[];
};

type TaskSnapshot = {
  schemaVersion: 1;
  updatedAt: string;
  updatedBy: string;
  source: string;
  clientUpdatedAt: string | null;
  counts: {
    total: number;
    active: number;
    done: number;
    deleted: number;
  };
  tasks: TaskSnapshotItem[];
};

type AuthResult =
  | { ok: true; email: string }
  | { ok: false; status: number; message: string };

const STORE_NAME = "munyaapp-task-snapshots";
const SNAPSHOT_KEY = "latest";
const TIME_ZONE = "Africa/Johannesburg";

export default async (req: Request, _context: Context) => {
  try {
    if (req.method === "GET") return handleGet(req);
    if (req.method === "POST") return handlePost(req);
    return textResponse("Method not allowed", 405);
  } catch (error) {
    console.error("Task snapshot function failed", error);
    return jsonResponse({ error: "Task snapshot function failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/tasks-snapshot",
};

async function handleGet(req: Request) {
  const readAuth = verifyRead(req);
  if (!readAuth.ok) return jsonResponse({ error: readAuth.message }, readAuth.status);

  const snapshot = await getSnapshot();
  if (!snapshot) {
    return textResponse("No Munya App task snapshot has been pushed yet.", 404);
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") || "";
  const wantsMarkdown = format.toLowerCase() === "markdown" ||
    (req.headers.get("accept") || "").includes("text/markdown");

  if (wantsMarkdown) {
    return new Response(renderMarkdown(snapshot), {
      headers: {
        "Content-Type": "text/markdown; charset=UTF-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return jsonResponse(snapshot);
}

async function handlePost(req: Request) {
  const writeAuth = await verifyWrite(req);
  if (!writeAuth.ok) return jsonResponse({ error: writeAuth.message }, writeAuth.status);

  const payload = await req.json().catch(() => null);
  const rawTasks = Array.isArray(payload) ? payload : payload?.tasks;
  if (!Array.isArray(rawTasks)) {
    return jsonResponse({ error: "Expected a task array or an object with a tasks array." }, 400);
  }

  const tasks = rawTasks.map(normalizeTask).filter((task): task is TaskSnapshotItem => Boolean(task));
  const snapshot: TaskSnapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: writeAuth.email,
    source: stringField(payload?.source) || "munyaapp",
    clientUpdatedAt: stringField(payload?.clientUpdatedAt) || null,
    counts: {
      total: tasks.length,
      active: tasks.filter((task) => !task.deletedAt && !task.done).length,
      done: tasks.filter((task) => !task.deletedAt && task.done).length,
      deleted: tasks.filter((task) => Boolean(task.deletedAt)).length,
    },
    tasks,
  };

  await getTaskStore().setJSON(SNAPSHOT_KEY, snapshot);
  return jsonResponse({ ok: true, updatedAt: snapshot.updatedAt, counts: snapshot.counts });
}

function getTaskStore() {
  const storeName = Netlify.context?.deploy?.context === "production"
    ? STORE_NAME
    : `${STORE_NAME}-preview`;
  return getStore({ name: storeName, consistency: "strong" });
}

async function getSnapshot() {
  return getTaskStore().get(SNAPSHOT_KEY, { type: "json" }) as Promise<TaskSnapshot | null>;
}

function normalizeTask(raw: unknown): TaskSnapshotItem | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const id = stringField(input.id);
  const title = stringField(input.title);
  if (!id || !title) return null;

  const task: TaskSnapshotItem = {
    id,
    title,
    list: stringField(input.list) || "Uncategorised",
    dueDate: dateField(input.dueDate),
    priority: stringField(input.priority) || null,
    done: Boolean(input.done),
    notes: stringField(input.notes),
    createdAt: stringField(input.createdAt) || null,
    updatedAt: stringField(input.updatedAt) || null,
  };

  copyStringFields(task, input, [
    "doneAt",
    "deletedAt",
    "source",
    "sourceKey",
    "sourceEventId",
    "sourceCalendarId",
    "sourceCalendarName",
    "sourceStartDate",
    "sourceStartTime",
    "sourceEndTime",
    "sourceStartAt",
    "sourceEndAt",
    "sourceNotes",
  ]);

  if (typeof input.sourceAllDay === "boolean") task.sourceAllDay = input.sourceAllDay;
  const links = normalizeLinks(input.links);
  if (links.length) task.links = links;
  return task;
}

function copyStringFields(
  task: TaskSnapshotItem,
  input: Record<string, unknown>,
  fields: Array<keyof TaskSnapshotItem>,
) {
  fields.forEach((field) => {
    const value = stringField(input[field]);
    if (value) {
      (task as Record<string, unknown>)[field] = value;
    }
  });
}

function normalizeLinks(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.map((link) => {
    if (!link || typeof link !== "object") return null;
    const input = link as Record<string, unknown>;
    const url = stringField(input.url || input.href);
    if (!url || seen.has(url)) return null;
    seen.add(url);
    return {
      url,
      label: stringField(input.label || input.title) || url,
    };
  }).filter((link): link is TaskLink => Boolean(link));
}

function verifyRead(req: Request): AuthResult {
  const configuredToken = env("TASKS_READ_TOKEN");
  if (!configuredToken) return { ok: true, email: "public" };

  const url = new URL(req.url);
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const suppliedToken = url.searchParams.get("token") ||
    req.headers.get("x-tasks-read-token") ||
    bearer;

  if (suppliedToken && suppliedToken === configuredToken) {
    return { ok: true, email: "reader" };
  }

  return { ok: false, status: 401, message: "Missing or invalid task snapshot read token." };
}

async function verifyWrite(req: Request): Promise<AuthResult> {
  const fallbackToken = env("TASKS_WRITE_TOKEN");
  if (fallbackToken && req.headers.get("x-tasks-write-token") === fallbackToken) {
    return { ok: true, email: "write-token" };
  }

  const allowedEmails = csvEnv("TASKS_ALLOWED_EMAILS").map((email) => email.toLowerCase());
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
  const email = stringField(info.email).toLowerCase();
  if (!email) {
    return { ok: false, status: 401, message: "Google token does not include email scope. Reconnect Google in the app." };
  }
  if (!allowedEmails.includes(email)) {
    return { ok: false, status: 403, message: "Google account is not allowed to publish task snapshots." };
  }

  const expectedClientId = env("TASKS_GOOGLE_CLIENT_ID");
  if (expectedClientId && stringField(info.aud) !== expectedClientId) {
    return { ok: false, status: 403, message: "Google token audience does not match this app." };
  }

  return { ok: true, email };
}

function renderMarkdown(snapshot: TaskSnapshot) {
  const active = snapshot.tasks
    .filter((task) => !task.deletedAt && !task.done)
    .sort(compareTasks);
  const done = snapshot.tasks
    .filter((task) => !task.deletedAt && task.done)
    .sort(compareDoneTasks);
  const today = todayInZone();
  const tomorrow = addDays(today, 1);

  const sections = [
    ["Overdue", active.filter((task) => task.dueDate && task.dueDate < today)],
    ["Today", active.filter((task) => task.dueDate === today)],
    ["Tomorrow", active.filter((task) => task.dueDate === tomorrow)],
    ["Upcoming", active.filter((task) => task.dueDate && task.dueDate > tomorrow)],
    ["No Due Date", active.filter((task) => !task.dueDate)],
    ["Done", done],
  ] as const;

  const lines = [
    "# Munya App Task Snapshot",
    "",
    `Updated: ${snapshot.updatedAt}`,
    `Updated by: ${snapshot.updatedBy}`,
    `Counts: ${snapshot.counts.active} active, ${snapshot.counts.done} done, ${snapshot.counts.deleted} deleted tombstones, ${snapshot.counts.total} total records`,
    "",
  ];

  sections.forEach(([title, tasks]) => {
    lines.push(`## ${title} (${tasks.length})`);
    if (!tasks.length) {
      lines.push("- None", "");
      return;
    }
    tasks.forEach((task) => {
      lines.push(formatTaskLine(task));
      if (task.notes) lines.push(`  Notes: ${singleLine(task.notes)}`);
      if (task.links?.length) {
        lines.push(`  Links: ${task.links.map((link) => `[${markdownEscape(link.label)}](${link.url})`).join(", ")}`);
      }
    });
    lines.push("");
  });

  return lines.join("\n");
}

function formatTaskLine(task: TaskSnapshotItem) {
  const checkbox = task.done ? "[x]" : "[ ]";
  const meta = [
    taskTime(task),
    task.list,
    task.sourceCalendarName,
    task.priority,
    task.dueDate ? `due ${task.dueDate}` : "",
    task.doneAt ? `done ${task.doneAt}` : "",
    task.updatedAt ? `updated ${task.updatedAt}` : "",
  ].filter((value): value is string => Boolean(value));
  return `- ${checkbox} ${markdownEscape(task.title)}${meta.length ? ` (${meta.map(markdownEscape).join(" | ")})` : ""}`;
}

function compareTasks(a: TaskSnapshotItem, b: TaskSnapshotItem) {
  return `${a.dueDate || "9999-99-99"} ${taskSortTime(a)} ${a.title}`
    .localeCompare(`${b.dueDate || "9999-99-99"} ${taskSortTime(b)} ${b.title}`);
}

function compareDoneTasks(a: TaskSnapshotItem, b: TaskSnapshotItem) {
  return (Date.parse(b.doneAt || b.updatedAt || "") || 0) - (Date.parse(a.doneAt || a.updatedAt || "") || 0);
}

function taskTime(task: TaskSnapshotItem) {
  if (!task.sourceStartTime) return "";
  return task.sourceEndTime ? `${task.sourceStartTime}-${task.sourceEndTime}` : task.sourceStartTime;
}

function taskSortTime(task: TaskSnapshotItem) {
  return task.sourceStartTime || "99:99";
}

function todayInZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function dateField(value: unknown) {
  const text = stringField(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function singleLine(value: string) {
  return markdownEscape(value).replace(/\s+/g, " ").trim();
}

function markdownEscape(value: string) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function env(key: string) {
  return Netlify.env.get(key)?.trim() || "";
}

function csvEnv(key: string) {
  return env(key).split(",").map((value) => value.trim()).filter(Boolean);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
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
