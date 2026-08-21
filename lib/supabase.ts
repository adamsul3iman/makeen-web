import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const forceMock = process.env.POS_FORCE_MOCK === "1";

/**
 * Shared Supabase client for the Back-office integration.
 *
 * Every import is server-only. Prefer the service-role key so public database
 * grants can be revoked without breaking API routes; the anon-key fallback is
 * temporary until that credential is configured in every deployment.
 */
export const supabase: SupabaseClient | null =
  !forceMock && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey || supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

export const isSupabaseServiceRoleConfigured = Boolean(
  !forceMock && supabaseUrl && supabaseServiceRoleKey,
);

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}

/**
 * Module-level cache for column existence probes. Key: `"table.column"`,
 * Value: boolean (true = exists, false = missing). Once set the value is
 * stable for the lifetime of the serverless function / dev-server process.
 */
const _columnCache = new Map<string, boolean>();

/**
 * Probe whether a column exists on a Supabase table by selecting it from a
 * single row. Result is cached per-process so the probe runs at most once.
 * Returns `true` (column exists) on any error *other* than the Postgres
 * "column does not exist" code 42703, because failing open is safer than
 * breaking every API route.
 */
export async function detectColumnExists(
  client: SupabaseClient,
  table: string,
  column: string,
): Promise<boolean> {
  const key = `${table}.${column}`;
  const cached = _columnCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const { error } = await client.from(table).select(column).limit(1);
    if (error && error.code === "42703") {
      _columnCache.set(key, false);
      return false;
    }
    _columnCache.set(key, true);
    return true;
  } catch {
    _columnCache.set(key, true);
    return true;
  }
}

/**
 * Page through every row of a table. PostgREST caps each response at the
 * project `max-rows` limit (default 1000 here), so full-table fetches must
 * walk ranges or large catalogs are silently truncated.
 */
export async function fetchAllRows<T>(
  client: SupabaseClient,
  table: string,
  select: string,
  storeId: string,
  orderBy?: string,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = client.from(table).select(select).eq("store_id", storeId).range(from, from + PAGE - 1);
    const q = orderBy ? base.order(orderBy, { ascending: true }) : base;
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}
