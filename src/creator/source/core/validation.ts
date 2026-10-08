import { z } from 'zod';
import { AppError } from './errors';
export const projectId = z.string().uuid();
export const mutationSchema = z.object({ projectId, expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128) });
export const settingsSchema = z.object({
  name: z.string().min(1).max(80), eyebrow: z.string().max(120), headline: z.string().min(1).max(240),
  description: z.string().max(1600), accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),heroImage:z.string().max(240).optional(),imageAlt:z.string().max(300).optional()
}).strict();
export const templateSchema = z.enum(['website', 'gallery', 'three', 'sketch', 'sketch2', 'game', 'audio', 'webgl', 'blocks', 'blank', 'physics', 'motion', 'chart']);
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT', result.error.issues.map(i => `${i.path.join('.') || 'Request'}: ${i.message}`).join('; ').slice(0, 700));
  return result.data;
}
export function safeRelativePath(value: string): string {
  if (!value || value.length > 240 || value.includes('\\') || value.startsWith('/') || /[\x00-\x1f\x7f:*?"<>|#%]/.test(value) || value.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.')||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new AppError('UNSAFE_PATH', 'Use a portable relative project path without hidden, reserved, or parent directories.');
  return value;
}
