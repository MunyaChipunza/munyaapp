export type FinanceRecord = Record<string, unknown>;
export type DashboardPayload = Record<string, unknown>;

const TIMEZONE = "Africa/Johannesburg";
const HEADER_SENTINEL = ["Status", "Section", "Group", "Item"];
const MONTHLY_SECTIONS = ["Income", "Monthly Cost", "Debt Payment", "Savings Contribution"];
const HISTORY_LIMIT = 180;

export interface DashboardBuildOptions {
  sourceName?: string;
  sourceUpdatedAt?: string | null;
  generatedAt?: Date;
  existingHistory?: Record<string, unknown>[];
}

function cleanText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cleanText(value).replace(/,/g, "").replace(/R/g, "").replace(/\$/g, "");
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function toSastIso(date = new Date()): string {
  const shifted = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+02:00");
}

function fmtMoney(value: number | null | undefined, currency = "ZAR"): string {
  if (value === null || value === undefined) return "-";
  const symbol = currency.toUpperCase() === "USD" ? "$" : "R";
  return `${symbol} ${value.toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sectionName(row: FinanceRecord): string {
  return cleanText(row.Section);
}

function tagName(row: FinanceRecord): string {
  return cleanText(row["Dashboard Tag"]).toLowerCase();
}

function monthlyAmount(row: FinanceRecord, field: string): number {
  return parseNumber(row[field]) ?? 0;
}

function balanceAmount(row: FinanceRecord): number {
  return parseNumber(row["Current Balance"]) ?? 0;
}

function includeRow(row: FinanceRecord): boolean {
  const status = cleanText(row.Status).toLowerCase();
  return !["closed", "remove", "archive", "ignore"].includes(status);
}

function rowsForSection(rows: FinanceRecord[], name: string): FinanceRecord[] {
  return rows.filter((row) => sectionName(row).toLowerCase() === name.toLowerCase());
}

function sumMonthly(rows: FinanceRecord[], section: string, field: string): number {
  return rowsForSection(rows, section).reduce((total, row) => total + monthlyAmount(row, field), 0);
}

function sumBalances(rows: FinanceRecord[], section: string, tags?: Set<string>): number {
  return rowsForSection(rows, section).reduce((total, row) => {
    if (tags && !tags.has(tagName(row))) return total;
    return total + balanceAmount(row);
  }, 0);
}

function lineItem(row: FinanceRecord): Record<string, unknown> {
  const budget = monthlyAmount(row, "Budget Monthly");
  const actual = monthlyAmount(row, "Actual This Month");
  return {
    section: sectionName(row),
    group: cleanText(row.Group),
    item: cleanText(row.Item),
    owner: cleanText(row.Owner),
    budget,
    actual,
    variance: actual - budget,
    currency: cleanText(row.Currency) || "ZAR",
    timing: cleanText(row.Timing),
    auto: cleanText(row.Auto),
    tag: cleanText(row["Dashboard Tag"]),
    priority: cleanText(row.Priority),
    notes: cleanText(row.Notes),
  };
}

function balanceItem(row: FinanceRecord): Record<string, unknown> {
  return {
    section: sectionName(row),
    group: cleanText(row.Group),
    item: cleanText(row.Item),
    owner: cleanText(row.Owner),
    balance: balanceAmount(row),
    currency: cleanText(row.Currency) || "ZAR",
    timing: cleanText(row.Timing),
    tag: cleanText(row["Dashboard Tag"]),
    priority: cleanText(row.Priority),
    notes: cleanText(row.Notes),
  };
}

function monthlyRows(rows: FinanceRecord[], sections: string[]): Record<string, unknown>[] {
  return rows.filter((row) => sections.includes(sectionName(row))).map(lineItem);
}

function balanceRows(rows: FinanceRecord[], section: string, tags?: Set<string>): Record<string, unknown>[] {
  return rowsForSection(rows, section)
    .filter((row) => !tags || tags.has(tagName(row)))
    .map(balanceItem)
    .sort((a, b) => Number(b.balance ?? 0) - Number(a.balance ?? 0));
}

function actualsCaptured(rows: FinanceRecord[]): boolean {
  let hasAnyActual = false;
  let hasVarianceFromBudget = false;
  for (const row of monthlyRows(rows, MONTHLY_SECTIONS)) {
    const actual = Number(row.actual ?? 0);
    const budget = Number(row.budget ?? 0);
    if (Math.abs(actual) > 0.009) hasAnyActual = true;
    if (Math.abs(actual - budget) > 0.009) hasVarianceFromBudget = true;
  }
  return hasAnyActual && hasVarianceFromBudget;
}

function normalizeActuals(rows: FinanceRecord[]): { rows: FinanceRecord[]; usingBudgetAsActuals: boolean } {
  if (actualsCaptured(rows)) return { rows, usingBudgetAsActuals: false };
  return {
    rows: rows.map((row) => {
      if (!MONTHLY_SECTIONS.includes(sectionName(row))) return row;
      return { ...row, "Actual This Month": monthlyAmount(row, "Budget Monthly") };
    }),
    usingBudgetAsActuals: true,
  };
}

function buildScorecard(
  incomeActual: number,
  surplusActual: number,
  runwayMonths: number | null,
  debtServiceRatio: number | null,
  savingsRate: number | null,
  netWorth: number,
): { score: number; pillars: Record<string, unknown>[] } {
  const surplusRatio = incomeActual ? surplusActual / incomeActual : 0;
  const liquidity = Math.round(clamp((runwayMonths ?? 0) / 6, 0, 1) * 35);
  const margin = Math.round(clamp(surplusRatio / 0.2, 0, 1) * 25);
  const leverage = Math.round(clamp((0.35 - (debtServiceRatio ?? 0)) / 0.35, 0, 1) * 20);
  const discipline = Math.round(clamp((savingsRate ?? 0) / 0.2, 0, 1) * 10);
  const balanceSheet = netWorth > 0 ? 10 : 0;
  return {
    score: liquidity + margin + leverage + discipline + balanceSheet,
    pillars: [
      { label: "Liquidity", score: liquidity, outOf: 35 },
      { label: "Margin", score: margin, outOf: 25 },
      { label: "Leverage", score: leverage, outOf: 20 },
      { label: "Discipline", score: discipline, outOf: 10 },
      { label: "Balance Sheet", score: balanceSheet, outOf: 10 },
    ],
  };
}

function healthSignal(score: number): Record<string, string> {
  if (score >= 80) return { label: "Strong", tone: "good" };
  if (score >= 60) return { label: "Stable", tone: "info" };
  if (score >= 40) return { label: "Tight", tone: "warn" };
  return { label: "Critical", tone: "bad" };
}

function dataQualityCard(usingBudgetAsActuals: boolean, monthlyLineCount: number): Record<string, string> {
  if (usingBudgetAsActuals) {
    return {
      label: "Budget-backed actuals",
      tone: "warn",
      detail: `Real spending has not been captured yet across ${monthlyLineCount} monthly lines, so the dashboard is using budget values as placeholder actuals. Structural risk signals are still useful, but variance is not yet real.`,
    };
  }
  return {
    label: "Actuals live",
    tone: "good",
    detail: "Google Sheets actuals are live. The dashboard can flag overspends, variances, and trend changes with confidence.",
  };
}

function zeroDate(startingCash: number, monthlySurplus: number): string | null {
  if (monthlySurplus >= 0 || startingCash <= 0) return null;
  const days = Math.round((startingCash / Math.abs(monthlySurplus)) * 30.4);
  const date = new Date(Date.now() + days * 86400000);
  return date.toLocaleDateString("en-ZA", { timeZone: TIMEZONE, day: "2-digit", month: "short", year: "numeric" });
}

function buildExecutiveSummary(
  reportMonth: string,
  signal: Record<string, string>,
  quality: Record<string, string>,
  actualSurplus: number,
  liquidCash: number,
  reserves: number,
  cashZeroDate: string | null,
  vehicleLoadRatio: number | null,
  netWorth: number,
): string {
  const direction = actualSurplus >= 0 ? "surplus" : "deficit";
  const zeroText = cashZeroDate ?? "not at risk on the current run-rate";
  const qualityNote = quality.label === "Budget-backed actuals" ? "Actuals are still budget-backed. " : "Real actuals are now live. ";
  return `${reportMonth}: household health reads ${signal.label?.toLowerCase()}. ${qualityNote}The current operating view implies a monthly ${direction} of ${fmtMoney(Math.abs(actualSurplus))}, with ${fmtMoney(liquidCash)} in transaction cash and ${fmtMoney(reserves)} in reserves. Vehicle load is ${pct(vehicleLoadRatio)}, tracked net worth is ${fmtMoney(netWorth)}, and the projected cash-zero date at the current burn rate is ${zeroText}.`;
}

function buildFocusItems(
  actualSurplus: number,
  cashZeroDate: string | null,
  vehicleLoadRatio: number | null,
  savingsRate: number | null,
  usingBudgetAsActuals: boolean,
): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  if (actualSurplus < 0) {
    items.push({ title: "Break the monthly deficit", detail: `Close a gap of at least ${fmtMoney(Math.abs(actualSurplus))} to stop cash from drifting down every month.`, tone: "bad" });
  }
  if (cashZeroDate) {
    items.push({ title: "Protect the cash-zero date", detail: `At the current run-rate, liquid cash and reserves would be exhausted around ${cashZeroDate}.`, tone: "bad" });
  }
  if ((vehicleLoadRatio ?? 0) >= 0.2) {
    items.push({ title: "Decide the vehicle strategy", detail: `Vehicle finance plus fuel is consuming ${pct(vehicleLoadRatio)} of take-home income.`, tone: (vehicleLoadRatio ?? 0) < 0.27 ? "warn" : "bad" });
  }
  if ((savingsRate ?? 0) <= 0.001) {
    items.push({ title: "Restart real saving", detail: "Formal savings are effectively at zero, so the balance sheet is not strengthening month to month.", tone: "warn" });
  }
  if (usingBudgetAsActuals) {
    items.push({ title: "Turn on real actuals", detail: "Replace placeholder actuals with what was truly spent so the dashboard becomes a decision engine instead of a dressed-up budget.", tone: "info" });
  }
  return items.slice(0, 4);
}

function performanceRow(label: string, budget: number, actual: number, incomeLine = false): Record<string, unknown> {
  const variance = actual - budget;
  let tone = "info";
  if (label === "Net Position") tone = actual >= 0 ? "good" : "bad";
  else if (incomeLine) tone = variance >= 0 ? "good" : "warn";
  else tone = variance > 0.009 ? "bad" : variance < -0.009 ? "good" : "info";
  return { label, budget, actual, variance, tone, ratio: budget ? actual / budget : null };
}

function buildPerformanceRows(
  incomeBudget: number,
  incomeActual: number,
  costsBudget: number,
  costsActual: number,
  debtBudget: number,
  debtActual: number,
  savingsBudget: number,
  savingsActual: number,
): Record<string, unknown>[] {
  const outflowsBudget = costsBudget + debtBudget + savingsBudget;
  const outflowsActual = costsActual + debtActual + savingsActual;
  return [
    performanceRow("Income", incomeBudget, incomeActual, true),
    performanceRow("Core Costs", costsBudget, costsActual),
    performanceRow("Debt Service", debtBudget, debtActual),
    performanceRow("Savings Allocation", savingsBudget, savingsActual),
    performanceRow("Net Position", incomeBudget - outflowsBudget, incomeActual - outflowsActual, true),
  ];
}

function buildCapitalStack(
  liquidCash: number,
  reserves: number,
  medicalSaver: number,
  investments: number,
  retirement: number,
  workingFloat: number,
  debtBalances: number,
  netWorth: number,
): Record<string, unknown>[] {
  return [
    { label: "Transaction Cash", amount: liquidCash, tone: "info", detail: "Current accounts available now" },
    { label: "Emergency Reserves", amount: reserves, tone: "good", detail: "Notice savings set aside" },
    { label: "Medical Saver", amount: medicalSaver, tone: "info", detail: "Momentum HealthSaver balance" },
    { label: "Card Float", amount: workingFloat, tone: "info", detail: "Positive available card float" },
    { label: "Investments", amount: investments, tone: "good", detail: "Tax-free and brokerage capital" },
    { label: "Retirement", amount: retirement, tone: "good", detail: "Long-term retirement assets" },
    { label: "Liabilities", amount: -debtBalances, tone: "bad", detail: "Tracked vehicle debt balances" },
    { label: "Net Worth", amount: netWorth, tone: netWorth >= 0 ? "good" : "bad", detail: "Tracked assets less tracked liabilities" },
  ];
}

function topMonthlyLines(rows: FinanceRecord[]): Record<string, unknown>[] {
  return monthlyRows(rows, ["Monthly Cost", "Debt Payment"])
    .sort((a, b) => Number(b.actual || b.budget || 0) - Number(a.actual || a.budget || 0))
    .slice(0, 8);
}

function overBudgetLines(rows: FinanceRecord[]): Record<string, unknown>[] {
  return monthlyRows(rows, ["Monthly Cost", "Debt Payment", "Savings Contribution"])
    .filter((row) => Number(row.budget ?? 0) > 0 && Number(row.actual ?? 0) > Number(row.budget ?? 0))
    .sort((a, b) => Number(b.variance ?? 0) - Number(a.variance ?? 0));
}

function buildWatchlist(
  rows: FinanceRecord[],
  actualSurplus: number,
  runwayMonths: number | null,
  savingsRate: number | null,
  vehicleLoad: number,
  vehicleLoadRatio: number | null,
  housingRatio: number | null,
  netWorth: number,
  cashZeroDate: string | null,
  usingBudgetAsActuals: boolean,
): Record<string, unknown>[] {
  const watchlist: Record<string, unknown>[] = [];
  if (!usingBudgetAsActuals) {
    for (const row of overBudgetLines(rows).slice(0, 4)) {
      watchlist.push({
        item: row.item,
        owner: row.owner || "Household",
        metric: fmtMoney(Number(row.variance ?? 0)),
        reason: "Actual spend is above budget on this line.",
        action: "Investigate whether this was a once-off or a structural overrun.",
        tone: "bad",
      });
    }
  }
  if (actualSurplus < 0) {
    watchlist.push({ item: "Monthly burn gap", owner: "Household", metric: fmtMoney(Math.abs(actualSurplus)), reason: "Total monthly outflows are above take-home income.", action: "Cut or reassign at least this amount to reach break-even.", tone: "bad" });
  }
  if (cashZeroDate) {
    watchlist.push({ item: "Cash-zero date", owner: "Household", metric: cashZeroDate, reason: "At the current burn rate, cash and reserves would eventually be exhausted.", action: "Protect reserves and fix the monthly deficit before this date moves closer.", tone: "bad" });
  }
  if ((runwayMonths ?? 0) < 3) {
    watchlist.push({ item: "Runway coverage", owner: "Household", metric: `${(runwayMonths ?? 0).toFixed(1)} months`, reason: "Cash plus reserves cover less than three months of full outflows.", action: "Treat reserve balances as protected and avoid optional leakage.", tone: (runwayMonths ?? 0) >= 1.5 ? "warn" : "bad" });
  }
  if ((vehicleLoadRatio ?? 0) >= 0.2) {
    watchlist.push({ item: "Vehicle exposure", owner: "Household", metric: `${pct(vehicleLoadRatio)} / ${fmtMoney(vehicleLoad)}`, reason: "Vehicle finance and fuel are taking a heavy share of take-home income.", action: "Decide whether to keep both cars, refinance, or lower transport load.", tone: (vehicleLoadRatio ?? 0) < 0.27 ? "warn" : "bad" });
  }
  if ((housingRatio ?? 0) >= 0.3) {
    watchlist.push({ item: "Housing concentration", owner: "Household", metric: pct(housingRatio), reason: "Rent is absorbing a large share of monthly income.", action: "Hold the rest of the cost base tightly so housing does not crowd out recovery.", tone: "warn" });
  }
  if ((savingsRate ?? 0) <= 0.001) {
    watchlist.push({ item: "Savings discipline", owner: "Household", metric: pct(savingsRate), reason: "No formal monthly saving is currently being captured.", action: "Restart even a small recurring transfer so progress becomes measurable.", tone: "warn" });
  }
  if (netWorth < 0) {
    watchlist.push({ item: "Balance sheet", owner: "Household", metric: fmtMoney(netWorth), reason: "Tracked liabilities still exceed tracked assets.", action: "Avoid new debt and use any upside to repair net worth.", tone: "bad" });
  }

  const deduped: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of watchlist) {
    const key = cleanText(item.item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 8);
}

function buildDecisionRows(
  actualSurplus: number,
  vehicleLoad: number,
  vehicleLoadRatio: number | null,
  reserves: number,
  savingsRate: number | null,
  usingBudgetAsActuals: boolean,
  topCostRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const largestNames = topCostRows.length ? topCostRows.slice(0, 3).map((row) => row.item).join(", ") : "the biggest monthly lines";
  const decisions: Record<string, unknown>[] = [];
  if (actualSurplus < 0) {
    decisions.push({ title: "Approve a break-even plan", owner: "Household", timeframe: "This month", impact: "High", detail: `Rework the monthly operating plan to remove at least ${fmtMoney(Math.abs(actualSurplus))} of burn. Start with ${largestNames}.`, tone: "bad" });
  }
  if ((vehicleLoadRatio ?? 0) >= 0.2) {
    decisions.push({ title: "Reset the vehicle strategy", owner: "Household", timeframe: "Next 30 days", impact: "High", detail: `BMW and Audi finance plus fuel are running at ${fmtMoney(vehicleLoad)} per month (${pct(vehicleLoadRatio)} of take-home). Decide whether both vehicles still make sense.`, tone: (vehicleLoadRatio ?? 0) < 0.27 ? "warn" : "bad" });
  }
  decisions.push({ title: "Protect reserve accounts", owner: "Kuhle", timeframe: "Immediate", impact: "High", detail: `Keep at least ${fmtMoney(reserves)} ring-fenced in notice savings unless there is a genuine emergency.`, tone: "warn" });
  if ((savingsRate ?? 0) <= 0.001) {
    decisions.push({ title: "Restart monthly saving", owner: "Household", timeframe: "Next payday", impact: "Medium", detail: "Use the savings contribution rows in the Google Sheet so the dashboard can start measuring real savings discipline again.", tone: "info" });
  }
  if (usingBudgetAsActuals) {
    decisions.push({ title: "Capture real actuals weekly", owner: "Household", timeframe: "Every week", impact: "High", detail: "Replace placeholder actuals with real spending so the watchlist can flag true overspends instead of only structural risks.", tone: "info" });
  }
  return decisions.slice(0, 5);
}

function currentSastMonthStart(): { year: number; month: number } {
  const shifted = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

function buildProjectionRows(startingCash: number, monthlySurplus: number, months = 6): Record<string, unknown>[] {
  const start = currentSastMonthStart();
  const rows: Record<string, unknown>[] = [];
  let opening = startingCash;
  for (let offset = 0; offset < months; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month + offset, 1));
    const closing = opening + monthlySurplus;
    rows.push({
      month: date.toLocaleDateString("en-ZA", { timeZone: "UTC", month: "short", year: "numeric" }),
      opening,
      movement: monthlySurplus,
      closing,
      tone: closing >= 0 && monthlySurplus >= 0 ? "good" : closing >= 0 ? "warn" : "bad",
    });
    opening = closing;
  }
  return rows;
}

function buildDebtHighlights(rows: FinanceRecord[]): Record<string, unknown>[] {
  const liabilities = balanceRows(rows, "Liability Balance");
  const debtRows = new Map(monthlyRows(rows, ["Debt Payment"]).map((row) => [cleanText(row.item).toLowerCase(), row]));
  return liabilities.map((item) => {
    const debtLine = debtRows.get(cleanText(item.item).toLowerCase());
    return {
      item: item.item,
      owner: item.owner,
      balance: item.balance,
      instalment: debtLine ? Number(debtLine.actual || debtLine.budget || 0) : 0,
      timing: debtLine ? debtLine.timing : item.timing,
      notes: debtLine && debtLine.notes ? debtLine.notes : item.notes,
    };
  });
}

function buildOpenItems(rows: FinanceRecord[]): Record<string, unknown>[] {
  return rowsForSection(rows, "Open Item").map((row) => ({
    area: cleanText(row.Group) || "Open Item",
    question: cleanText(row.Item),
    assumption: cleanText(row.Timing),
    update: cleanText(row.Notes),
  }));
}

function parseDateOnly(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = cleanText(value);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return new Date(year, Number(slash[2]) - 1, Number(slash[1]));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysToDue(dueDate: Date): number {
  const shifted = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const due = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

function firstPresent(row: FinanceRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && cleanText(row[key]) !== "") return row[key];
  }
  return null;
}

function buildUpcomingPayments(rows: FinanceRecord[]): Record<string, unknown>[] {
  return rows
    .filter((row) => ["upcoming payment", "payment", "upcoming payments"].includes(sectionName(row).toLowerCase()))
    .map((row) => {
      const dueDate = parseDateOnly(firstPresent(row, ["Due Date", "DueDate", "Timing"]));
      const amount = parseNumber(firstPresent(row, ["Amount", "Actual This Month", "Budget Monthly", "Current Balance"])) ?? 0;
      const days = parseNumber(firstPresent(row, ["Days To Due", "DaysToDue", "daysToDue"]));
      return {
        item: cleanText(row.Item),
        amount,
        dueDate: dueDate ? formatIsoDate(dueDate) : cleanText(firstPresent(row, ["Due Date", "DueDate", "Timing"])),
        daysToDue: days ?? (dueDate ? daysToDue(dueDate) : null),
        owner: cleanText(row.Owner) || "Household",
        auto: ["yes", "true", "1", "auto"].includes(cleanText(row.Auto).toLowerCase()),
        category: cleanText(firstPresent(row, ["Category", "Group", "Dashboard Tag"])) || "Payment",
        tone: cleanText(row.Priority).toLowerCase() === "critical" ? "bad" : cleanText(row.Priority).toLowerCase() === "high" ? "warn" : "info",
      };
    })
    .filter((row) => cleanText(row.item));
}

function historySnapshot(
  reportMonth: string,
  generatedAt: string,
  sourceUpdatedAt: string | null,
  incomeActual: number,
  outflowsActual: number,
  surplusActual: number,
  cashBuffer: number,
  netWorth: number,
  vehicleLoad: number,
  savingsRate: number | null,
  runwayMonths: number | null,
  debtServiceRatio: number | null,
): Record<string, unknown> {
  return {
    reportMonth,
    generatedAt,
    sourceUpdatedAt,
    incomeActual,
    outflowsActual,
    surplusActual,
    cashBuffer,
    netWorth,
    vehicleLoad,
    savingsRate,
    runwayMonths,
    debtServiceRatio,
  };
}

function appendHistory(history: Record<string, unknown>[] | undefined, snapshot: Record<string, unknown>): Record<string, unknown>[] {
  const cleaned = (history ?? []).filter((item) => item && typeof item === "object" && item.sourceUpdatedAt);
  if (cleaned.length && cleaned[cleaned.length - 1].sourceUpdatedAt === snapshot.sourceUpdatedAt) {
    cleaned[cleaned.length - 1] = snapshot;
  } else {
    cleaned.push(snapshot);
  }
  return cleaned.slice(-HISTORY_LIMIT);
}

function findHeaderRow(values: unknown[][]): number {
  const limit = Math.min(values.length, 60);
  for (let index = 0; index < limit; index += 1) {
    const row = values[index] ?? [];
    const first = row.slice(0, 4).map(cleanText);
    if (HEADER_SENTINEL.every((value, offset) => first[offset] === value)) return index;
  }
  throw new Error("Could not find the finance data header row. Expected Status, Section, Group, Item.");
}

function rowsFromSheetValues(values: unknown[][], headerRowIndex: number): FinanceRecord[] {
  const headers = (values[headerRowIndex] ?? []).map(cleanText);
  const records: FinanceRecord[] = [];
  let blankStreak = 0;
  for (let index = headerRowIndex + 1; index < values.length; index += 1) {
    const rowValues = values[index] ?? [];
    if (!rowValues.slice(0, headers.length).some((value) => value !== null && value !== undefined && cleanText(value) !== "")) {
      blankStreak += 1;
      if (blankStreak >= 12) break;
      continue;
    }
    blankStreak = 0;
    const record: FinanceRecord = {};
    headers.forEach((header, offset) => {
      if (header) record[header] = rowValues[offset] ?? null;
    });
    if (cleanText(record.Item)) records.push(record);
  }
  return records;
}

export function buildDashboardFromSheetValues(values: unknown[][], options: DashboardBuildOptions = {}): DashboardPayload {
  const headerRowIndex = findHeaderRow(values);
  const rawRows = rowsFromSheetValues(values, headerRowIndex).filter(includeRow);
  const { rows, usingBudgetAsActuals } = normalizeActuals(rawRows);
  const reportMonth = cleanText(values[3]?.[1]) || cleanText(values[4]?.[1]) || new Date().toLocaleDateString("en-ZA", { timeZone: TIMEZONE, month: "long", year: "numeric" });

  const incomeBudget = sumMonthly(rows, "Income", "Budget Monthly");
  const incomeActual = sumMonthly(rows, "Income", "Actual This Month");
  const costsBudget = sumMonthly(rows, "Monthly Cost", "Budget Monthly");
  const costsActual = sumMonthly(rows, "Monthly Cost", "Actual This Month");
  const debtBudget = sumMonthly(rows, "Debt Payment", "Budget Monthly");
  const debtActual = sumMonthly(rows, "Debt Payment", "Actual This Month");
  const savingsBudget = sumMonthly(rows, "Savings Contribution", "Budget Monthly");
  const savingsActual = sumMonthly(rows, "Savings Contribution", "Actual This Month");

  const outflowsBudget = costsBudget + debtBudget + savingsBudget;
  const outflowsActual = costsActual + debtActual + savingsActual;
  const surplusBudget = incomeBudget - outflowsBudget;
  const surplusActual = incomeActual - outflowsActual;

  const liquidCash = sumBalances(rows, "Asset Balance", new Set(["cash"]));
  const reserves = rowsForSection(rows, "Asset Balance").reduce((total, row) => {
    const item = cleanText(row.Item).toLowerCase();
    if (tagName(row) === "reserve" && !item.includes("healthsaver")) return total + balanceAmount(row);
    return total;
  }, 0);
  const medicalSaver = rowsForSection(rows, "Asset Balance").reduce((total, row) => {
    const item = cleanText(row.Item).toLowerCase();
    const group = cleanText(row.Group).toLowerCase();
    if (item.includes("healthsaver") || group === "medical saver") return total + balanceAmount(row);
    return total;
  }, 0);
  const investments = sumBalances(rows, "Asset Balance", new Set(["investment"]));
  const retirement = sumBalances(rows, "Asset Balance", new Set(["retirement"]));
  const workingFloat = sumBalances(rows, "Asset Balance", new Set(["float", "working-float"]));
  const debtBalances = sumBalances(rows, "Liability Balance");
  const totalAssets = sumBalances(rows, "Asset Balance");
  const netWorth = totalAssets - debtBalances;

  const debtServiceRatio = incomeActual ? debtActual / incomeActual : null;
  const savingsRate = incomeActual ? savingsActual / incomeActual : null;
  const runwayMonths = outflowsActual ? (liquidCash + reserves) / outflowsActual : null;
  const coverageRatio = outflowsActual ? incomeActual / outflowsActual : null;
  const cashZeroDate = zeroDate(liquidCash + reserves, surplusActual);

  const vehicleDebtService = monthlyRows(rows, ["Debt Payment"])
    .filter((row) => {
      const group = cleanText(row.group).toLowerCase();
      const item = cleanText(row.item).toLowerCase();
      return group.includes("vehicle") || item.includes("vehicle") || item.includes("finance") || item.includes("bmw") || item.includes("audi");
    })
    .reduce((total, row) => total + Number(row.actual ?? 0), 0);
  const fuelSpend = monthlyRows(rows, ["Monthly Cost"])
    .filter((row) => cleanText(row.item).toLowerCase().includes("fuel"))
    .reduce((total, row) => total + Number(row.actual ?? 0), 0);
  const vehicleLoad = vehicleDebtService + fuelSpend;
  const vehicleLoadRatio = incomeActual ? vehicleLoad / incomeActual : null;
  const rentLine = monthlyRows(rows, ["Monthly Cost"]).find((row) => cleanText(row.item).toLowerCase() === "rent");
  const housingRatio = rentLine && incomeActual ? Number(rentLine.actual ?? 0) / incomeActual : null;

  const { score, pillars } = buildScorecard(incomeActual, surplusActual, runwayMonths, debtServiceRatio, savingsRate, netWorth);
  const signal = healthSignal(score);
  const quality = dataQualityCard(usingBudgetAsActuals, monthlyRows(rows, MONTHLY_SECTIONS).length);
  const topCostRows = topMonthlyLines(rows);
  const operatingLines = monthlyRows(rows, ["Monthly Cost", "Debt Payment", "Savings Contribution"]).sort((a, b) => {
    const sectionCompare = cleanText(a.section).localeCompare(cleanText(b.section));
    if (sectionCompare) return sectionCompare;
    return Number(b.actual || b.budget || 0) - Number(a.actual || a.budget || 0);
  });

  const generatedAt = toSastIso(options.generatedAt);
  const sourceUpdatedAt = options.sourceUpdatedAt ?? generatedAt;
  const history = appendHistory(
    options.existingHistory,
    historySnapshot(reportMonth, generatedAt, sourceUpdatedAt, incomeActual, outflowsActual, surplusActual, liquidCash + reserves, netWorth, vehicleLoad, savingsRate, runwayMonths, debtServiceRatio),
  );

  return {
    title: "Family Finance Command Deck",
    subtitle: "Executive view of household cash, commitments, debt, and long-term capital.",
    reportMonth,
    sourceName: options.sourceName || "Google Sheets",
    generatedAt,
    sourceUpdatedAt,
    refreshSeconds: 300,
    dataMode: quality.label,
    dataQuality: quality,
    health: signal,
    healthScore: score,
    pillarScores: pillars,
    executiveSummary: buildExecutiveSummary(reportMonth, signal, quality, surplusActual, liquidCash, reserves, cashZeroDate, vehicleLoadRatio, netWorth),
    focusItems: buildFocusItems(surplusActual, cashZeroDate, vehicleLoadRatio, savingsRate, usingBudgetAsActuals),
    summaryCards: [
      { label: "Take-home Income", value: fmtMoney(incomeActual), detail: "Current monthly income run-rate", tone: "good" },
      { label: "Monthly Outflows", value: fmtMoney(outflowsActual), detail: "Living costs, debt, and savings transfers", tone: "warn" },
      { label: "Net Position", value: fmtMoney(surplusActual), detail: "Income minus all monthly outflows", tone: surplusActual >= 0 ? "good" : "bad" },
      { label: "Cash Buffer", value: fmtMoney(liquidCash + reserves), detail: "Transaction cash plus reserves", tone: "info" },
      { label: "Full-Outflow Runway", value: runwayMonths !== null ? `${runwayMonths.toFixed(1)} months` : "-", detail: "Cash and reserves vs total monthly outflows", tone: (runwayMonths ?? 0) >= 6 ? "good" : (runwayMonths ?? 0) >= 3 ? "warn" : "bad" },
      { label: "Cash-Zero Date", value: cashZeroDate ?? "Protected", detail: "Date cash would hit zero at the current burn rate", tone: cashZeroDate ? "bad" : "good" },
      { label: "Vehicle Load", value: fmtMoney(vehicleLoad), detail: `${pct(vehicleLoadRatio)} of take-home income`, tone: (vehicleLoadRatio ?? 0) >= 0.27 ? "bad" : (vehicleLoadRatio ?? 0) >= 0.2 ? "warn" : "good" },
      { label: "Savings Rate", value: pct(savingsRate), detail: "Formal savings as a share of income", tone: (savingsRate ?? 0) <= 0.001 ? "bad" : "good" },
      { label: "Net Worth", value: fmtMoney(netWorth), detail: "Tracked assets less tracked liabilities", tone: netWorth >= 0 ? "good" : "bad" },
    ],
    performanceRows: buildPerformanceRows(incomeBudget, incomeActual, costsBudget, costsActual, debtBudget, debtActual, savingsBudget, savingsActual),
    capitalStack: buildCapitalStack(liquidCash, reserves, medicalSaver, investments, retirement, workingFloat, debtBalances, netWorth),
    topCostRows,
    watchlistRows: buildWatchlist(rows, surplusActual, runwayMonths, savingsRate, vehicleLoad, vehicleLoadRatio, housingRatio, netWorth, cashZeroDate, usingBudgetAsActuals),
    decisionRows: buildDecisionRows(surplusActual, vehicleLoad, vehicleLoadRatio, reserves, savingsRate, usingBudgetAsActuals, topCostRows),
    projectionRows: buildProjectionRows(liquidCash + reserves, surplusActual, 6),
    cashAccounts: balanceRows(rows, "Asset Balance", new Set(["cash", "reserve", "medical", "float", "working-float"])),
    investmentRows: balanceRows(rows, "Asset Balance", new Set(["investment", "retirement"])),
    debtHighlights: buildDebtHighlights(rows),
    upcomingPayments: buildUpcomingPayments(rawRows),
    operatingLines,
    incomeRows: monthlyRows(rows, ["Income"]),
    openItems: buildOpenItems(rows),
    history,
    totals: {
      budgetIncome: incomeBudget,
      actualIncome: incomeActual,
      budgetOutflows: outflowsBudget,
      actualOutflows: outflowsActual,
      budgetSurplus: surplusBudget,
      actualSurplus: surplusActual,
      liquidCash,
      reserves,
      medicalSaver,
      investments,
      retirement,
      workingFloat,
      debtBalances,
      coverageRatio,
      vehicleLoad,
      vehicleLoadRatio,
      housingRatio,
      netWorth,
    },
    stale: false,
    fallback: null,
  };
}
