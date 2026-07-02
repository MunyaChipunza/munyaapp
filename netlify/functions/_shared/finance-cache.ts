import { getDeployStore, getStore } from "@netlify/blobs";
import type { DashboardPayload } from "./finance-transformer.js";
import { isProductionDeploy } from "./env.js";

const STORE_NAME = "finance-dashboard";
const SNAPSHOT_KEY = "latest";

export interface SnapshotEnvelope {
  cachedAt: string;
  payload: DashboardPayload;
}

function snapshotStore() {
  if (isProductionDeploy()) return getStore({ name: STORE_NAME, consistency: "strong" });
  return getDeployStore(STORE_NAME);
}

export async function readSnapshot(): Promise<SnapshotEnvelope | null> {
  return (await snapshotStore().get(SNAPSHOT_KEY, { type: "json" })) as SnapshotEnvelope | null;
}

export async function writeSnapshot(payload: DashboardPayload): Promise<SnapshotEnvelope> {
  const envelope = {
    cachedAt: new Date().toISOString(),
    payload,
  };
  await snapshotStore().setJSON(SNAPSHOT_KEY, envelope);
  return envelope;
}

export async function readBlobValue<T>(key: string): Promise<T | null> {
  return (await snapshotStore().get(key, { type: "json" })) as T | null;
}

export async function writeBlobValue(key: string, value: unknown): Promise<void> {
  await snapshotStore().setJSON(key, value);
}
