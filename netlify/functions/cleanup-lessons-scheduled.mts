import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

const STORE_NAME = "munyaapp-task-snapshots";
const SNAPSHOT_KEY = "latest";
const COMBINED_TITLE = "Daily Spotify learning - five lessons";

const TARGET_TITLES = new Set([
  "Lesson 1 - Sermon: Work and Calling by Tim Keller",
  "Lesson 2 - Entrepreneurship: Solve a Real Problem",
  "Lesson 3 - Operations: Find the Real Value, Remove the Waste",
  "Lesson 4 - Money: Make Saving Easier by Design",
  "Lesson 5 - Fatherhood: Presence Before Performance",
  "Spotify Lesson 1 - Faith: Our Call - Holy Living by Timothy Keller",
  "Spotify Lesson 2 - Entrepreneurship: Solve a Real Problem",
  "Spotify Lesson 3 - Operations: Find Value and Remove Waste",
  "Spotify Lesson 4 - Money: Make Saving Easier by Design",
  "Spotify Lesson 5 - Fatherhood: What Will My Children Repeat or Reject?",
]);

type Task = {
  title?: string;
  list?: string;
  notes?: string;
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
    console.log("Lesson cleanup skipped: snapshot missing.");
    return;
  }

  const now = new Date().toISOString();
  let removed = 0;
  let normalised = 0;

  snapshot.tasks = snapshot.tasks.map((task) => {
    const title = String(task.title || "");

    if (TARGET_TITLES.has(title) && !task.deletedAt) {
      removed += 1;
      return {
        ...task,
        deletedAt: now,
        updatedAt: now,
      };
    }

    if (title === COMBINED_TITLE && !task.deletedAt) {
      const cleanNotes = String(task.notes || "").replace(/\bKALM\b/g, "the business");
      if (task.list !== "Personal" || cleanNotes !== String(task.notes || "")) {
        normalised += 1;
        return {
          ...task,
          list: "Personal",
          notes: cleanNotes,
          updatedAt: now,
        };
      }
    }

    return task;
  });

  if (!removed && !normalised) {
    console.log("Lesson cleanup: no changes required.");
    return;
  }

  snapshot.updatedAt = now;
  snapshot.updatedBy = "daily-spotify-learning-cleanup";
  snapshot.source = "assistant-cleanup";
  snapshot.clientUpdatedAt = now;
  snapshot.counts = {
    total: snapshot.tasks.length,
    active: snapshot.tasks.filter((task) => !task.deletedAt && !task.done).length,
    done: snapshot.tasks.filter((task) => !task.deletedAt && task.done).length,
    deleted: snapshot.tasks.filter((task) => Boolean(task.deletedAt)).length,
  };

  await store.setJSON(SNAPSHOT_KEY, snapshot);
  console.log(`Lesson cleanup removed ${removed} cards and normalised ${normalised} combined task.`);
};

export const config: Config = {
  schedule: "* * * * *",
};
