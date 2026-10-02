export declare const PROJECT_NAME_ERROR = "Project name can only contain up to 100 lowercase letters, digits, and the characters '.', '_', '-'.";
/** Returns an error message when a project name is not a safe single path segment. */
export declare function validateProjectName(value: string): string | undefined;
/** Parses and normalizes a project name at an external input boundary. */
export declare function parseProjectName(value: string): string;
