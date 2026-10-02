import type { Prompter } from "./prompter.js";
import type { SelectOption } from "./ask.js";
export interface EditableSelectQuestion<T> {
    key: string;
    message: string;
    options: readonly SelectOption<T>[];
    recommended?: T;
    required?: boolean;
    editable: {
        key: string;
        value: T;
        label: string;
        recommended: string;
        validate?: (raw: string) => string | null;
    };
}
export interface EditableSelectAnswer<T> {
    value: T;
    text?: string;
}
/** Renders the specialized one-row editable select through a terminal prompter. */
export declare function renderEditableQuestion<T>(prompter: Prompter, question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>>;
