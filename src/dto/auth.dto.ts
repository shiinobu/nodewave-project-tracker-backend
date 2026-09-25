import { z } from 'zod';

export const registerSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    role: z.enum(['PM', 'INTERNAL', 'CLIENT']),
    department: z.enum(['UIUX', 'FRONTEND', 'BACKEND']).optional(),
    // Only read when role is PM; see assertMayRegisterAs in auth.service.ts.
    inviteCode: z.string().optional(),
  })
  .refine((data) => data.role !== 'INTERNAL' || !!data.department, {
    message: 'department is required when role is INTERNAL',
    path: ['department'],
  });

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
