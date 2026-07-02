import type { Config } from "@netlify/functions";
import { refreshFinanceSnapshot } from "./_shared/finance-service.js";

export default async (req: Request) => {
  let nextRun = "unknown";
  try {
    const body = (await req.json().catch(() => null)) as { next_run?: string } | null;
    nextRun = body?.next_run ?? nextRun;
  } catch {
    nextRun = "unknown";
  }

  const result = await refreshFinanceSnapshot();
  console.log(`Finance dashboard snapshot refreshed from ${result.source}. Next run: ${nextRun}`);
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
