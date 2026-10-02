import { z } from "#compiled/zod/index.js";
export declare const VercelProjectLinkSchema: z.ZodObject<{
    projectId: z.ZodString;
    orgId: z.ZodString;
    projectName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Validated Vercel owner and project identifiers from Vercel link metadata. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;
/** Reads a validated Vercel project link without mutating local project state. */
export declare function readVercelProjectLink(projectPath: string): Promise<VercelProjectLink | undefined>;
