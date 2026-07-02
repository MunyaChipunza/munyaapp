import { createSign } from "node:crypto";
import { getEnv } from "./env.js";

export interface SheetFetchResult {
  values: unknown[][];
  sourceUpdatedAt: string;
  sourceName: string;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

function requiredEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readServiceAccount(): ServiceAccountCredentials {
  const rawJson = getEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as Partial<ServiceAccountCredentials>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key.");
    }
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
    };
  }

  const clientEmail = requiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = requiredEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
  return { client_email: clientEmail, private_key: privateKey };
}

async function getAccessToken(): Promise<string> {
  const credentials = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google auth failed with HTTP ${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Google auth response did not include an access token.");
  return payload.access_token;
}

function isPublicSheetMode(): boolean {
  return ["1", "true", "yes"].includes((getEnv("GOOGLE_SHEETS_PUBLIC") || "").toLowerCase());
}

function rangeSheetName(range: string): string {
  const sheetName = range.includes("!") ? range.split("!")[0] : range;
  return sheetName.replace(/^'|'$/g, "").replace(/''/g, "'");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

function toSastIso(date: Date): string {
  const shifted = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+02:00");
}

export async function fetchFinanceSheetValues(): Promise<SheetFetchResult> {
  const sheetId = requiredEnv("GOOGLE_SHEET_ID");
  const range = getEnv("GOOGLE_SHEET_RANGE") || "Budget!A:Z";
  if (isPublicSheetMode()) {
    const sheetName = getEnv("GOOGLE_SHEET_NAME") || rangeSheetName(range);
    const gid = getEnv("GOOGLE_SHEET_GID");
    const url = gid
      ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`
      : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    const response = await fetch(url, { headers: { Accept: "text/csv" } });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Public Google Sheets CSV fetch failed with HTTP ${response.status}: ${detail}`);
    }
    const responseDate = response.headers.get("date");
    return {
      values: parseCsv(await response.text()),
      sourceUpdatedAt: responseDate ? toSastIso(new Date(responseDate)) : toSastIso(new Date()),
      sourceName: `Google Sheets public CSV: ${sheetName}`,
    };
  }

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Sheets fetch failed with HTTP ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as { values?: unknown[][]; range?: string };
  if (!Array.isArray(payload.values)) throw new Error("Google Sheets response did not include row values.");
  const responseDate = response.headers.get("date");
  return {
    values: payload.values,
    sourceUpdatedAt: responseDate ? toSastIso(new Date(responseDate)) : toSastIso(new Date()),
    sourceName: `Google Sheets: ${payload.range || range}`,
  };
}
