/** Prevent shell access; task-worker files use only bounded Eve file wrappers. */
import { disableTool } from "eve/tools";

export default disableTool();
