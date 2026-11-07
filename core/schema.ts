import { z } from 'zod';
import { databaseReadSchema, databaseSchema } from './database-schema';

export const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
const fieldSchema = z.strictObject({ name: nameSchema, value: z.string().min(1).max(8192) });
export const itemSchema = z
  .strictObject({
    name: nameSchema,
    kind: z.enum(['secret', 'login', 'group']),
    fields: z.array(fieldSchema).min(1).max(32),
  })
  .superRefine((item, ctx) => {
    const names = item.fields.map((field) => field.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate fields' });
    if (item.kind === 'secret' && (names.length !== 1 || names[0] !== 'value')) {
      ctx.addIssue({ code: 'custom', message: 'Single secrets use the value field' });
    }
    if (
      item.kind === 'login' &&
      (names.length !== 2 || !names.includes('username') || !names.includes('password'))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Logins require username and password' });
    }
  });
export const operationSchema = z.strictObject({
  name: nameSchema,
  item: nameSchema,
  url: z.string().min(1).max(2048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  auth: z.enum(['headers', 'basic']),
  bindings: z
    .array(
      z.strictObject({
        header: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/),
        field: nameSchema,
        prefix: z
          .string()
          .max(64)
          .regex(/^[\x20-\x7e]*$/),
      }),
    )
    .max(16),
  body: z.string().max(32768),
});
export const durationSchema = z.enum(['once', 'hour', 'day', 'until-revoked']);
export const grantSchema = z.strictObject({
  operation: nameSchema,
  expiresAt: z.number().int().positive().nullable(),
  remainingUses: z.literal(1).nullable(),
  dataSharingAccepted: z.literal(true).optional(),
});
export const snapshotRecordSchema = z.strictObject({
  id: z.uuid(),
  key: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;
const auditSchema = z.strictObject({
  at: z.number().int(),
  event: z.enum([
    'saved-item',
    'saved-operation',
    'approved',
    'revoked',
    'attempted',
    'finished',
    'failed',
    'deleted',
  ]),
  name: nameSchema,
  status: z.number().int().min(100).max(599).optional(),
});
export const dataSchema = z
  .strictObject({
    items: z.array(itemSchema).max(256),
    operations: z.array(operationSchema).max(256),
    databases: z.array(databaseSchema).max(64).default([]),
    snapshots: z.array(snapshotRecordSchema).max(64).default([]),
    grants: z.array(grantSchema).max(320),
    audit: z.array(auditSchema).max(200),
  })
  .refine((data) => {
    const names = [...data.operations, ...data.databases].map((entry) => entry.name);
    return (
      new Set(names).size === names.length &&
      new Set(data.snapshots.map((snapshot) => snapshot.id)).size === data.snapshots.length &&
      data.databases.every(
        (database) =>
          database.source !== 'snapshot' || data.snapshots.some((s) => s.id === database.snapshot),
      )
    );
  });
export type VaultData = z.infer<typeof dataSchema>;
export const agentCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status') }),
  z.strictObject({ action: z.literal('list-items') }),
  z.strictObject({ action: z.literal('list-operations') }),
  z.strictObject({ action: z.literal('request-access'), operation: nameSchema }),
  z.strictObject({ action: z.literal('run'), operation: nameSchema }),
  z.strictObject({ action: z.literal('list-databases') }),
  z.strictObject({ action: z.literal('read-database'), query: databaseReadSchema }),
]);

export class SafeError extends Error {}
export function publicError(error: unknown): string {
  return error instanceof SafeError
    ? error.message
    : 'The operation failed. No secret values were returned.';
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SafeError('Invalid input. Check names, fields and size limits.');
  return result.data;
}
