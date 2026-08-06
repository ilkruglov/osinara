/** Revalidate trusted workspace access before each task-worker file read. */
import { TRUSTED_WORKER_FILE_TOOLS } from "../../../lib/tool-policy/trusted-worker-file-tools.js";

export default TRUSTED_WORKER_FILE_TOOLS.read_file;
