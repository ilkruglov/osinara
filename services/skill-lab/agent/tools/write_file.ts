/** Keep the exact skill package immutable while preserving Eve's real file-write semantics. */
import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/defaults";
import { z } from "zod";
import { experimentPath } from "../../../../agent/lib/authored-skills/skill-experiment.js";
export default defineTool({
  ...writeFile,
  async execute(input, ctx) {
    z.object({ filePath: experimentPath, content: z.string().max(32_000) }).strict().parse(input);
    return writeFile.execute(input, ctx);
  },
});
