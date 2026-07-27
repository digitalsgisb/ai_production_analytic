import type { DatabasePool } from "./db.js";
import { newId } from "./security.js";

export async function writeAudit(
  pool: DatabasePool,
  entry: {
    actorUserId?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
    ipAddress?: string | null;
  },
) {
  await pool.query(
    `INSERT INTO assistant.audit_log
       (id, actor_user_id, action, target_type, target_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId(),
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ipAddress ?? null,
    ],
  );
}
