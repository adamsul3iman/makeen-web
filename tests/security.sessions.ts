process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/rest/v1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "security-test-anon-key";
process.env.ADMIN_SESSION_SECRET = "security-test-secret-that-is-not-used-in-production";
delete process.env.POS_FORCE_MOCK;

export {};

const { adminSessionCookieHeader, clearAdminSessionCookieHeader } = await import("../lib/adminSession");
const { deviceSessionCookieHeader, clearDeviceSessionCookieHeader } = await import("../lib/deviceSession");
const { createSignedSession, verifySignedSession } = await import("../lib/signedSession");
const { getAdminAccess, getStoreAccess } = await import("../lib/requestAuth");

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean): void {
  if (condition) passed += 1;
  else failures.push(label);
}

function cookiePair(header: string): string {
  return header.split(";", 1)[0];
}

const adminCookie = cookiePair(
  adminSessionCookieHeader({ storeId: "store-main", email: "owner@example.test", name: "Owner" }),
);
const deviceCookie = cookiePair(
  deviceSessionCookieHeader({
    storeId: "store-main",
    actorId: "cashier-1",
    actorName: "Cashier",
    role: "cashier",
  }),
);

const forgedHeaders = new Request("http://localhost/api/expenses", {
  headers: {
    "x-pos-store-id": "store-victim",
    "x-pos-role": "admin",
    "x-pos-admin-email": "victim@example.test",
  },
});
check("forged headers cannot create an admin session", (await getAdminAccess(forgedHeaders)) === null);
check("forged headers cannot create an operational session", (await getStoreAccess(forgedHeaders)) === null);

const adminRequest = new Request("http://localhost/api/expenses", {
  headers: {
    Cookie: adminCookie,
    "x-pos-store-id": "store-victim",
    "x-pos-role": "cashier",
  },
});
const adminAccess = await getAdminAccess(adminRequest);
const adminStoreAccess = await getStoreAccess(adminRequest);
check("admin cookie authenticates the owner", adminAccess?.email === "owner@example.test");
check("admin cookie fixes the tenant scope", adminAccess?.storeId === "store-main");
check("admin cookie also grants operational access", adminStoreAccess?.role === "admin");
check("forged store header never overrides admin scope", adminStoreAccess?.storeId === "store-main");

const cashierRequest = new Request("http://localhost/api/catalog", {
  headers: { Cookie: deviceCookie, "x-pos-role": "admin", "x-pos-store-id": "store-victim" },
});
const cashierStoreAccess = await getStoreAccess(cashierRequest);
check("device cookie grants operational access", cashierStoreAccess?.role === "cashier");
check("device cookie fixes the tenant scope", cashierStoreAccess?.storeId === "store-main");
check("device cookie never grants back-office access", (await getAdminAccess(cashierRequest)) === null);

const handedOffRequest = new Request("http://localhost/api/expenses", {
  headers: { Cookie: `${adminCookie}; ${deviceCookie}` },
});
check(
  "cashier device session suppresses an older owner cookie",
  (await getAdminAccess(handedOffRequest)) === null,
);

const tamperedRequest = new Request("http://localhost/api/catalog", {
  headers: { Cookie: `${deviceCookie.slice(0, -1)}x` },
});
check("tampered device signature is rejected", (await getStoreAccess(tamperedRequest)) === null);

const validator = (value: unknown): value is { id: string } =>
  Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
const shortSession = createSignedSession("expiry-test", { id: "one" }, 10, 1_000);
check("signed session is valid before expiry", verifySignedSession("expiry-test", shortSession, validator, 10_999)?.id === "one");
check("signed session expires server-side", verifySignedSession("expiry-test", shortSession, validator, 11_000) === null);
check("session namespaces cannot be swapped", verifySignedSession("other", shortSession, validator, 2_000) === null);

check("admin logout cookie expires immediately", clearAdminSessionCookieHeader().includes("Max-Age=0"));
check("device logout cookie expires immediately", clearDeviceSessionCookieHeader().includes("Max-Age=0"));

if (failures.length > 0) {
  for (const failure of failures) console.error(`  x ${failure}`);
  console.error(`Security sessions: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`Security sessions: ${passed} passed, 0 failed`);
