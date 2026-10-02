/** Returns whether a token belongs to eve's framework-reserved session command namespace. */
export declare function isReservedSessionCommandToken(token: string): boolean;
/** Derives the framework-reserved stable command inbox token for a session. */
export declare function sessionCommandHookToken(sessionId: string): string;
