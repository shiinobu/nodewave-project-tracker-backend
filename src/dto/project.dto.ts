import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  memberUserIds: z.array(z.string()).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
