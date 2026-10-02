import type { EditableSelectQuestion } from "./ask-editable.js";
import type { MultiSelectQuestion, Question } from "./ask.js";
/** Thrown when a skippable question is skipped, so the box can branch on it. */
export declare class SkippedSignal extends Error {
    readonly key: string;
    constructor(key: string);
}
/** Any question the channel can carry, for signals that quote one. */
export type AnyQuestion = Question<unknown> | EditableSelectQuestion<unknown> | MultiSelectQuestion<unknown>;
/**
 * Headless refusal that keeps the whole question: an agent driver can relay
 * exactly what is missing (key, message, options) instead of a bare string.
 */
export declare class InteractionRequired extends Error {
    readonly question: AnyQuestion;
    constructor(question: AnyQuestion);
}
/** Thrown when a pre-supplied answer fails the question's own validation. */
export declare class InvalidAnswerError extends Error {
    readonly question: AnyQuestion;
    constructor(question: AnyQuestion, message: string);
    get key(): string;
}
