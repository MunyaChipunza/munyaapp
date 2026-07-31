import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

const STORE_NAME = "munyaapp-task-snapshots";
const SNAPSHOT_KEY = "latest";
const TOKEN_HASH = "31b008639613d9f96686c6daaa95ee1e5b7f9dd9f6fc4021e0132a60a3bcff81";

const TARGET_TITLES = new Set([
  "Spotify Lesson 1 - Faith: Our Call - Holy Living by Timothy Keller",
  "Spotify Lesson 2 - Entrepreneurship: Solve a Real Problem",
  "Spotify Lesson 3 - Operations: Find Value and Remove Waste",
  "Spotify Lesson 4 - Money: Make Saving Easier by Design",
  "Spotify Lesson 5 - Fatherhood: What Will My Children Repeat or Reject?",
]);

type Task = {
  title?: string;
  done?: boolean;
  deletedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type Snapshot = {
  updatedAt?: string;
  updatedBy?: string;
  source?: string;
  clientUpdatedAt?: string | null;
  tasks?: Task[];
  counts?: {
    total: number;
    active: number;
    done: number;
    deleted: number;
  };
  [key: string]: unknown;
};

export default async (req: Request) => {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supplied = new URL(req.url).searchParams.get("token") || "";
  const suppliedHash = createHash("sha256").update(supplied).digest("hex");
  if (!supplied || suppliedHash !== TOKEN_HASH) {
    return json({ error: "Unauthorised" }, 401);
  }

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const snapshot = await store.get(SNAPSHOT_KEY, { type: "json" }) as Snapshot | null;
  if (!snapshot || !Array.isArray(snapshot.tasks)) {
    return json({ error: "Task snapshot not found" }, 404);
  }

  const now = new Date().toISOString();
  let changed = 0;

  snapshot.tasks = snapshot.tasks.map((task) => {
    if (!TARGET_TITLES.has(String(task.title || "")) || task.deletedAt) return task;
    changed += 1;
    return {
      ...task,
      deletedAt: now,
      updatedAt: now,
    };
  });

  snapshot.updatedAt = now;
  snapshot.updatedBy = "spotify-lesson-cleanup";
  snapshot.source = "assistant-cleanup";
  snapshot.clientUpdatedAt = now;
  snapshot.counts = {
    total: snapshot.tasks.length,
    active: snapshot.tasks.filter((task) => !task.deletedAt && !task.done).length,
    done: snapshot.tasks.filter((task) => !task.deletedAt && task.done).length,
    deleted: snapshot.tasks.filter((task) => Boolean(task.deletedAt)).length,
  };

  await store.setJSON(SNAPSHOT_KEY, snapshot);

  const remainingTargets = snapshot.tasks
    .filter((task) => TARGET_TITLES.has(String(task.title || "")) && !task.deletedAt)
    .map((task) => task.title);

  return json({
    ok: true,
    changed,
    remainingTargets,
    counts: snapshot.counts,
    updatedAt: now,
  });
};

export const config: Config = {
  path: "/api/cleanup-lessons",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}
