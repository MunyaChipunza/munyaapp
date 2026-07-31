import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

const STORE_NAME = "munyaapp-task-snapshots";
const SNAPSHOT_KEY = "latest";

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

export default async () => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const snapshot = await store.get(SNAPSHOT_KEY, { type: "json" }) as Snapshot | null;
  if (!snapshot || !Array.isArray(snapshot.tasks)) {
    console.log("Spotify lesson cleanup skipped: snapshot missing.");
    return;
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

  if (!changed) {
    console.log("Spotify lesson cleanup: no active legacy cards found.");
    return;
  }

  snapshot.updatedAt = now;
  snapshot.updatedBy = "spotify-lesson-scheduled-cleanup";
  snapshot.source = "assistant-cleanup";
  snapshot.clientUpdatedAt = now;
  snapshot.counts = {
    total: snapshot.tasks.length,
    active: snapshot.tasks.filter((task) => !task.deletedAt && !task.done).length,
    done: snapshot.tasks.filter((task) => !task.deletedAt && task.done).length,
    deleted: snapshot.tasks.filter((task) => Boolean(task.deletedAt)).length,
  };

  await store.setJSON(SNAPSHOT_KEY, snapshot);
  console.log(`Spotify lesson cleanup tombstoned ${changed} tasks.`);
};

export const config: Config = {
  schedule: "* * * * *",
};
