import { z } from 'zod';

export const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  department: z.enum(['UIUX', 'FRONTEND', 'BACKEND']),
  assigneeId: z.string().min(1).optional(),
  isClientVisible: z.boolean().optional(),
  dependsOnTaskIds: z.array(z.string()).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  isClientVisible: z.boolean().optional(),
  version: z.number().int().nonnegative(),
});

export const updateTaskStatusSchema = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']),
  version: z.number().int().nonnegative(),
});

export const addDependencySchema = z.object({
  dependsOnTaskId: z.string().min(1),
});

export const addCommentSchema = z.object({
  body: z.string().min(1),
  // Only a PM's choice is honored; an INTERNAL author's comment is always forced internal.
  isInternal: z.boolean().optional(),
});

export const addAttachmentSchema = z.object({
  fileName: z.string().min(1),
  fileUrl: z.url({ protocol: /^https?$/ }),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>;
export type AddDependencyInput = z.infer<typeof addDependencySchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
export type AddAttachmentInput = z.infer<typeof addAttachmentSchema>;
