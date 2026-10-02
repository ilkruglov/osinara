import { RegistryPackageComponentSchema } from "./registry-package.js";
import { z } from "#compiled/zod/index.js";
const RegistrySetupSchema = z.object({
    package: z.string().min(1),
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  EveRegistryMetadataSchema = z.object({
    requires: z.string().optional(),
    docs: z.string().min(1).optional(),
    implementation: z.enum([`native`, `chat-sdk`]).optional(),
    setup: z
      .union([RegistrySetupSchema, z.array(RegistrySetupSchema).min(1)])
      .transform((e) => (Array.isArray(e) ? e : [e]))
      .optional(),
    components: z.array(RegistryPackageComponentSchema).min(1).optional(),
  }),
  EveRegistryItemMetadataSchema = z.object({
    meta: z.object({ eve: EveRegistryMetadataSchema.optional() }).optional(),
  }),
  OfficialRegistryCatalogSchema = z.object({
    items: z.array(
      z.object({
        name: z.string().min(1),
        meta: z
          .object({ eve: EveRegistryMetadataSchema.optional() })
          .optional(),
      }),
    ),
  }),
  RegistryPresentationManifestSchema = EveRegistryItemMetadataSchema.extend({
    title: z.string().optional(),
    description: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    files: z.array(z.object({ target: z.string() })).optional(),
  });
function eveMetadataFromRegistryItem(e) {
  return EveRegistryItemMetadataSchema.parse(e).meta?.eve;
}
function parseOfficialRegistrySearchMetadata(e) {
  let { items: t } = OfficialRegistryCatalogSchema.parse(e),
    n = new Map();
  for (let e of t) {
    let { docs: t, implementation: r } = e.meta?.eve ?? {};
    (t !== void 0 || r !== void 0) &&
      n.set(e.name, { docs: t, implementation: r });
  }
  return n;
}
function parseRegistryPresentationManifest(e) {
  return RegistryPresentationManifestSchema.safeParse(e).data;
}
export {
  eveMetadataFromRegistryItem,
  parseOfficialRegistrySearchMetadata,
  parseRegistryPresentationManifest,
};
