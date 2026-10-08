import {z} from 'zod';
import {mutationSchema,projectId} from './validation';

const revision=z.number().int().min(0).max(2_147_483_647);
export const mergeIdSchema=z.string().regex(/^[a-f0-9]{64}$/);
const choice=z.discriminatedUnion('choice',[
  z.object({conflictId:mergeIdSchema,choice:z.literal('draft')}).strict(),
  z.object({conflictId:mergeIdSchema,choice:z.literal('current')}).strict(),
  z.object({conflictId:mergeIdSchema,choice:z.literal('custom'),text:z.string().max(200_000)}).strict()
]);
const resolution={choices:z.array(choice).max(64).optional(),manualContent:z.string().max(2_000_000).optional()};
const oneMode=(input:{choices?:unknown[];manualContent?:string})=>input.manualContent===undefined||!input.choices?.length;
export const mergePrepareSchema=z.object({projectId,path:z.string().min(1).max(240),baseRevision:revision,draft:z.string().max(2_000_000)}).strict();
export const mergeReadSchema=z.object({projectId,mergeId:mergeIdSchema,side:z.enum(['base','draft','current','merged']),conflictId:mergeIdSchema.optional(),offset:z.number().int().min(0).max(2_147_483_647).default(0),limit:z.number().int().min(1).max(64_000).default(64_000),...resolution}).strict().refine(oneMode,{message:'Choose conflict resolutions or a complete manual result, not both.'});
export const mergeApplySchema=mutationSchema.extend({mergeId:mergeIdSchema,path:z.string().min(1).max(240),resultHash:mergeIdSchema.nullable(),...resolution}).strict().refine(oneMode,{message:'Choose conflict resolutions or a complete manual result, not both.'});
