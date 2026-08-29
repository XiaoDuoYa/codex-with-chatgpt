import { z } from "zod";

export const C2CStateSchema = z.enum(["INIT", "PLAN", "EXECUTING", "EXECUTED", "DONE", "BLOCKED"]);
export type C2CState = z.infer<typeof C2CStateSchema>;

export const TaskIdSchema = z.string().regex(/^c2c_[0-9a-f]{8}$/);

export const C2CMessageSchema = z.object({
  protocolVersion: z.literal(1),
  taskId: TaskIdSchema,
  iteration: z.number().int().nonnegative(),
  state: C2CStateSchema,
  sections: z.record(z.string(), z.string()),
});
export type C2CMessage = z.infer<typeof C2CMessageSchema>;

export const TaskSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  taskId: TaskIdSchema,
  transport: z.enum(["mcp", "github"]),
  state: C2CStateSchema,
  iteration: z.number().int().nonnegative(),
  goal: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  repository: z
    .object({
      provider: z.literal("github"),
      owner: z.string().min(1),
      name: z.string().min(1),
      remote: z.string().min(1),
      branch: z.string().min(1),
    })
    .nullable(),
  taskBaseCommit: z.string().nullable(),
  iterationBaseCommit: z.string().nullable(),
  codeHeadCommit: z.string().nullable(),
  declaredChangedFiles: z.array(z.string()),
  tests: z.object({
    status: z.enum(["not_run", "running", "passed", "failed"]),
    summary: z.string().nullable(),
    command: z.string().nullable(),
  }),
  reviewFocus: z.string(),
  lastImported: z
    .object({
      state: z.enum(["PLAN", "DONE", "BLOCKED"]),
      receivedAt: z.string().datetime(),
    })
    .nullable(),
  pendingDecision: z
    .object({
      state: z.literal("DONE"),
      taskId: TaskIdSchema,
      iteration: z.number().int().nonnegative(),
      acceptedAt: z.string().datetime(),
    })
    .nullable(),
  blockedFrom: z
    .object({
      state: C2CStateSchema,
      iteration: z.number().int().nonnegative(),
      code: z.string(),
      reason: z.string(),
    })
    .nullable(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
