import { isAbsolute } from 'node:path';
import { z } from 'zod';

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
const text = z
  .string()
  .max(4096)
  .refine((value) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));
const path = text.min(1).refine(isAbsolute);
export const commandProposalSchema = z
  .strictObject({
    name,
    executable: path,
    cwd: path,
    args: z.array(text).max(64),
    bindings: z
      .array(
        z.strictObject({
          env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
          item: name,
          field: name,
        }),
      )
      .min(1)
      .max(16),
    timeoutMs: z.number().int().min(100).max(120_000),
  })
  .superRefine((command, ctx) => {
    const names = command.bindings.map((binding) => binding.env);
    // These influence loader/interpreter startup rather than application authentication.
    if (
      new Set(names).size !== names.length ||
      names.some((env) =>
        /^(PATH|HOME|USERPROFILE|SYSTEMROOT|COMSPEC|PATHEXT|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|BASH_ENV|ENV|SHELLOPTS|IFS|LD_.*|DYLD_.*|PYTHON.*)$/.test(
          env,
        ),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate or reserved environment binding' });
    }
  });
export const commandApprovalSchema = z.strictObject({
  revision: z.uuid(),
  executionAccepted: z.literal(true),
  dataSharingAccepted: z.literal(true),
});
export const commandRunSchema = z.strictObject({ operation: name, revision: z.uuid() });
