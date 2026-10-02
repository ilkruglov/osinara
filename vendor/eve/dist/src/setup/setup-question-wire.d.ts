import type { AnyQuestion } from "./ask.js";
export interface SetupWireOption {
    id: string;
    label: string;
    hint?: string;
    disabled?: boolean;
    disabledReason?: string;
    locked?: boolean;
    lockedReason?: string;
}
type SharedWireQuestion = {
    key: string;
    message: string;
    required: boolean;
};
export type SetupWireQuestion = (SharedWireQuestion & {
    kind: "confirm";
    recommended?: boolean;
}) | (SharedWireQuestion & {
    kind: "text";
    placeholder?: string;
    sensitive?: false;
}) | (SharedWireQuestion & {
    kind: "environment";
    variable: string;
    sensitive: true;
}) | (SharedWireQuestion & {
    kind: "select";
    recommended?: string;
    options: readonly SetupWireOption[];
}) | (SharedWireQuestion & {
    kind: "multi-select";
    recommended?: readonly string[];
    options: readonly SetupWireOption[];
}) | (SharedWireQuestion & {
    kind: "editable-select";
    recommended?: string;
    options: readonly SetupWireOption[];
    editable: {
        key: string;
        optionId: string;
        label: string;
        recommended: string;
    };
});
/** Removes runtime values and validators from one internal setup question. */
export declare function setupQuestionToWire(question: AnyQuestion): SetupWireQuestion;
export {};
