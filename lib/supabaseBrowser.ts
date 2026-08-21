import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Client-side Supabase client using ONLY the public anon key.
 *
 * This is the only Supabase client safe for the browser bundle. It never
 * touches the service-role key, PLATFORM_OPS_SECRET, or any server-only
 * credential. All data protection is delegated to Supabase RLS policies.
 */
let _client: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient | null {
  if (_client) return _client;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  _client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return _client;
}

export function isSupabaseBrowserConfigured(): boolean {
  return supabaseUrl != null && supabaseAnonKey != null;
}
