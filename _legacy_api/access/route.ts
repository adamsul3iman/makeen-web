import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import {
  STAFF_CAPABILITIES,
  capabilitiesFor,
  isStaffCapability,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const capability = new URL(request.url).searchParams.get("capability");
  if (!isStaffCapability(capability)) {
    return Response.json({ error: "invalid_capability" }, { status: 400 });
  }

  const access = await getCapabilityAccess(request, capability);
  if (!access) {
    return capabilityAuthorizationError(request, capability);
  }

  return Response.json({
    access: {
      actorId: access.actorId,
      actorName: access.actorName,
      roleCode: access.roleCode,
      roleName: access.roleName,
      capabilities: access.role === "admin"
        ? [...STAFF_CAPABILITIES]
        : capabilitiesFor(access),
      limits: access.limits,
    },
  });
}
