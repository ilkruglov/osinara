export interface QuestionOption {
    id: string;
    value: unknown;
}
interface QuestionWithOptions<O extends QuestionOption> {
    key: string;
    options: readonly O[];
}
/** Finds an option by the stable id used by prompt and wire boundaries. */
export declare function optionById<O extends QuestionOption>(question: QuestionWithOptions<O>, id: unknown): O | undefined;
/** Finds an option by its in-process rich value. */
export declare function optionByValue<O extends QuestionOption>(question: QuestionWithOptions<O>, value: O["value"]): O | undefined;
/** Maps a rich value to its stable id, rejecting an invalid question definition. */
export declare function requiredOptionId<O extends QuestionOption>(question: QuestionWithOptions<O>, value: O["value"], role: string): string;
export {};
