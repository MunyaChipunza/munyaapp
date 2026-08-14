import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

declare const Netlify: {
  context?: { deploy?: { context?: string } };
};

type TaskLink = { url: string; label: string };
type Task = {
  id: string;
  title: string;
  list: string;
  dueDate: string | null;
  priority: string | null;
  done: boolean;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string;
  links?: TaskLink[];
  [key: string]: unknown;
};
type Snapshot = {
  schemaVersion: 1;
  updatedAt: string;
  updatedBy: string;
  source: string;
  clientUpdatedAt: string | null;
  counts: { total: number; active: number; done: number; deleted: number };
  tasks: Task[];
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

const TOKEN_SHA256 = "70d1ef1acd44f9d4b0f6a0cbae62bfe96a4e400f0bfd38150f53058d8ee173e7";
const MIGRATION_KEY = "movie-summary-only-2026-08-14-v1";

const SUMMARIES: Record<string, string> = {
  "MK-047": "Five close-knit friends lean on one another as romance, work and family complications force them to rethink what they want from love.",
  "MK-059": "After Travis returns home from prison, his partner and teenage daughter discover him wearing a red dress, forcing the family to confront secrets, identity and intimacy.",
  "MK-079": "A jewelry designer accidentally sends wedding bands to the wrong person and teams up with the best man to track them down before the wedding.",
  "MK-080": "A wedding planner must pull together her sister's last-minute Christmas Eve wedding while unexpectedly working alongside her former fiancé.",
  "MK-081": "An ambitious sports reporter trying to prove herself gets help from a freelance sports photographer, and an unexpected connection begins to grow.",
  "MK-082": "A struggling boutique owner is hired to style a famous R&B playboy for Christmas, and their image makeover begins to blur into real feelings.",
  "MK-084": "Two single parents accidentally swap phones and their children's backpacks on Christmas Eve, forcing them to cover for each other as chaos turns into romance.",
  "MK-087": "In 1950s Harlem, aspiring TV producer Sylvie falls for jazz saxophonist Robert; years later, their careers and choices bring them back together.",
  "MK-088": "Soldier Charles Monroe King writes a journal of love and life lessons for his infant son while his partner Dana reflects on their relationship and family.",
  "MK-089": "Aretha Franklin rises from church singer to global star while fighting to claim her voice amid controlling relationships, abuse and career pressure.",
  "MK-090": "A woman returns home to help with her family's Christmas carnival, where the festivities and a visiting photojournalist stir up unexpected romance.",
  "MK-091": "An aspiring superstar joins an underdog Atlanta church praise team and discovers faith, community and purpose while preparing for a national choir competition.",
  "MK-093": "After taking her six-year-old son from foster care, Inez tries to build a stable home for them in a changing New York City while hiding a life-changing secret.",
  "MK-094": "Three lifelong best friends support one another across decades of love, marriage, loss and personal upheaval.",
  "MK-095": "A disgraced megachurch pastor and his wife try to rebuild their congregation and public image after scandal, exposing painful truths about faith, marriage and accountability.",
  "MK-096": "An ethnomusicology student in Nashville investigates the mystery behind an overlooked music group and grows close to a producer who helps her uncover the past.",
  "MK-097": "A single mother, surprised by her daughter's engagement and facing major life changes, travels to Gulf Shores and unexpectedly finds a new chance at love."
};

export default async (req: Request) => {
  if (req.method !== "GET") return response({ error: "Method not allowed" }, 405);
  const supplied = new URL(req.url).searchParams.get("token") || "";
  if (!supplied || sha256(supplied) !== TOKEN_SHA256) return response({ error: "Unauthorized" }, 401);

  const production = Netlify.context?.deploy?.context === "production";
  const snapshotStore = getStore({ name: production ? "munyaapp-task-snapshots" : "munyaapp-task-snapshots-preview", consistency: "strong" });
  const intakeStore = getStore({ name: production ? "munyaapp-task-intake" : "munyaapp-task-intake-preview", consistency: "strong" });
  const snapshot = await snapshotStore.get("latest", { type: "json" }) as Snapshot | null;
  if (!snapshot?.tasks?.length) return response({ error: "No task snapshot found" }, 404);

  const now = new Date().toISOString();
  const patched: Task[] = [];
  for (const task of snapshot.tasks) {
    if (task.done || task.deletedAt) continue;
    const match = task.title.match(/\b(MK-\d{3})\b/);
    const code = match?.[1] || "";
    const summary = SUMMARIES[code];
    if (!summary || task.notes === summary) continue;
    task.notes = summary;
    task.updatedAt = now;
    patched.push(task);
  }

  if (!patched.length) {
    return response({ ok: true, patched: 0, titles: [], message: "Already migrated or no matching active tasks." });
  }

  snapshot.updatedAt = now;
  snapshot.updatedBy = "movie-summary-migration";
  await snapshotStore.setJSON("latest", snapshot);

  const existing = await intakeStore.get("queue", { type: "json" }) as IntakeState | null;
  const state: IntakeState = existing?.schemaVersion === 1 && Array.isArray(existing.items)
    ? existing
    : { schemaVersion: 1, updatedAt: now, items: [], consumedSourceKeys: [] };
  const targetIds = new Set(patched.map((task) => task.id));
  state.items = state.items.filter((item) => !targetIds.has(item.id));
  for (const task of patched) {
    const queued: IntakeTask = {
      id: task.id,
      title: task.title,
      list: task.list,
      dueDate: task.dueDate,
      priority: task.priority,
      done: false,
      notes: task.notes,
      createdAt: task.createdAt || now,
      updatedAt: now,
      source: "ai",
      sourceKey: `migration:${MIGRATION_KEY}:${task.id}`
    };
    if (task.links?.length) queued.links = task.links;
    state.items.push(queued);
  }
  state.updatedAt = now;
  await intakeStore.setJSON("queue", state);

  return response({
    ok: true,
    patched: patched.length,
    titles: patched.map((task) => task.title),
    intakePending: state.items.length,
    updatedAt: now
  });
};

export const config: Config = { path: "/api/movie-task-summary-migration" };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
