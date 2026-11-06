import { z } from 'zod';

export const sqlIdentifierSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
const schemaName = sqlIdentifierSchema.refine(
  (value) => !value.toLowerCase().startsWith('pg_') && value.toLowerCase() !== 'information_schema',
);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
export const databaseSchema = z.strictObject({
  engine: z.enum(['postgres', 'sqlite']).optional(),
  name,
  item: name,
  field: name,
  tables: z
    .array(
      z.strictObject({
        schema: schemaName,
        table: sqlIdentifierSchema,
        columns: z
          .array(sqlIdentifierSchema)
          .min(1)
          .max(16)
          .refine((values) => new Set(values).size === values.length),
      }),
    )
    .min(1)
    .max(32)
    .refine(
      (tables) =>
        new Set(tables.map((table) => `${table.schema}.${table.table}`)).size === tables.length,
    ),
});
export const databaseReadSchema = z.strictObject({
  connection: name,
  schema: schemaName,
  table: sqlIdentifierSchema,
  columns: z
    .array(sqlIdentifierSchema)
    .min(1)
    .max(16)
    .refine((values) => new Set(values).size === values.length),
  filters: z
    .array(
      z.strictObject({
        column: sqlIdentifierSchema,
        value: z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]),
      }),
    )
    .max(8)
    .default([]),
  limit: z.number().int().min(1).max(100).default(50),
});
