import { supabase } from "@/lib/supabase";
import { MOCK_STORE_ID, MOCK_STORE_NAME } from "@/lib/tenant";
import type { StoreSummary } from "@/types/pos.types";

/**
 * Public store registry: the list of active tenants the login screen
 * renders in its store picker. Never exposes owner contact data.
 */
export async function GET(): Promise<Response> {
  if (!supabase) {
    return Response.json({
      stores: [
        {
          id: MOCK_STORE_ID,
          name: MOCK_STORE_NAME,
          subscriptionStatus: "active",
        } satisfies StoreSummary,
      ],
    });
  }

  const { data, error } = await supabase
    .from("stores")
    .select("id,name,subscription_status")
    .eq("subscription_status", "active")
    .order("name", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const stores: StoreSummary[] = (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    subscriptionStatus: s.subscription_status,
  }));
  return Response.json({ stores });
}
