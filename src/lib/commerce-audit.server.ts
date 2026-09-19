import { requestId, logEvent } from "@/lib/api-response";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export async function auditCommerceMutation(
  admin: Admin,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await admin.from("audit_logs").insert({
    actor_id: null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata: input.metadata ?? {},
    request_id: requestId(),
  });
  if (error) {
    logEvent("error", "commerce_audit_write_failed", {
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
    });
    return false;
  }
  return true;
}
