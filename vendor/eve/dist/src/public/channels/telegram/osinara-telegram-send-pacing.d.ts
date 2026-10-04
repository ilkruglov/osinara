/** Hand-written declaration of the Osinara runtime module built from scripts/eve-runtime/telegram-send-pacing.ts. */
export interface TelegramSendPacerOptions {
    globalPerSecond?: number;
    groupPerMinute?: number;
    now?: () => number;
    privateGapMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
export interface TelegramSendPacer {
    acquire(method: string, body: unknown): Promise<void>;
    retryAfter(seconds: number): boolean;
    waitForPause(): Promise<void>;
}
export declare function createTelegramSendPacer(options?: TelegramSendPacerOptions): TelegramSendPacer;
export declare function telegramSendPacerSettings(env?: Readonly<Record<string, string | undefined>>): Required<Pick<TelegramSendPacerOptions, "globalPerSecond" | "groupPerMinute" | "privateGapMs">>;
export declare function telegramRetryAfterSeconds(body: unknown): number | null;
export declare const telegramSendPacer: TelegramSendPacer;
