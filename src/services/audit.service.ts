import type { Prisma } from '../../generated/prisma/client';

interface FieldChange {
  column: string;
  oldValue: unknown;
  newValue: unknown;
}

const toAuditValue = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Writes one immutable audit row per changed field. Must always be called inside the
 * same `prisma.$transaction` as the mutation it documents, so a failed audit write
 * rolls the mutation back too (the log can never silently drift from reality).
 */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  params: {
    taskId: string;
    userId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE';
    changes?: FieldChange[];
  },
): Promise<void> {
  const changes = params.changes ?? [];

  if (changes.length === 0) {
    await tx.auditLog.create({
      data: { taskId: params.taskId, userId: params.userId, action: params.action },
    });
    return;
  }

  await tx.auditLog.createMany({
    data: changes.map((change) => ({
      taskId: params.taskId,
      userId: params.userId,
      action: params.action,
      changedColumn: change.column,
      oldValue: toAuditValue(change.oldValue),
      newValue: toAuditValue(change.newValue),
    })),
  });
}
