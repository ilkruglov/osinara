export declare const schema: import("drizzle-orm/pg-core").PgSchema<"workflow">;
export declare const workflowRunStatus: import("drizzle-orm/pg-core").PgEnum<["pending" | "running" | "completed" | "failed" | "cancelled", ...("pending" | "running" | "completed" | "failed" | "cancelled")[]]>;
export declare const stepStatus: import("drizzle-orm/pg-core").PgEnum<["pending" | "running" | "completed" | "failed" | "cancelled", ...("pending" | "running" | "completed" | "failed" | "cancelled")[]]>;
export declare const waitStatus: import("drizzle-orm/pg-core").PgEnum<["completed" | "waiting", ...("completed" | "waiting")[]]>;
/**
 * Sadly we do `any[]` right now
 */
export type SerializedContent = any[];
export declare const runs: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_runs";
    schema: "workflow";
    columns: {
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        outputJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "output";
            tableName: "workflow_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: SerializedContent;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: SerializedContent;
        }>;
        output: import("drizzle-orm/pg-core").PgColumn<{
            name: "output_cbor";
            tableName: "workflow_runs";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: SerializedContent;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        deploymentId: import("drizzle-orm/pg-core").PgColumn<{
            name: "deployment_id";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgEnumColumn";
            data: "pending" | "running" | "completed" | "failed" | "cancelled";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pending" | "running" | "completed" | "failed" | "cancelled", ...("pending" | "running" | "completed" | "failed" | "cancelled")[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        workflowName: import("drizzle-orm/pg-core").PgColumn<{
            name: "name";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        specVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "spec_version";
            tableName: "workflow_runs";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        executionContextJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "execution_context";
            tableName: "workflow_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: Record<string, any>;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: Record<string, any>;
        }>;
        executionContext: import("drizzle-orm/pg-core").PgColumn<{
            name: "execution_context_cbor";
            tableName: "workflow_runs";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: Record<string, any>;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        inputJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "input";
            tableName: "workflow_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: SerializedContent;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: SerializedContent;
        }>;
        input: import("drizzle-orm/pg-core").PgColumn<{
            name: "input_cbor";
            tableName: "workflow_runs";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: SerializedContent;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        errorJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "error";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        error: import("drizzle-orm/pg-core").PgColumn<{
            name: "error_cbor";
            tableName: "workflow_runs";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: unknown;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        errorCode: import("drizzle-orm/pg-core").PgColumn<{
            name: "error_code";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        attributes: import("drizzle-orm/pg-core").PgColumn<{
            name: "attributes";
            tableName: "workflow_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: Record<string, string>;
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: Record<string, string>;
        }>;
        encryptionPublicKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "encryption_public_key";
            tableName: "workflow_runs";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_runs";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "workflow_runs";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "workflow_runs";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "workflow_runs";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        expiredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expired_at";
            tableName: "workflow_runs";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const events: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_events";
    schema: "workflow";
    columns: {
        eventId: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "workflow_events";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        eventType: import("drizzle-orm/pg-core").PgColumn<{
            name: "type";
            tableName: "workflow_events";
            dataType: "string";
            columnType: "PgVarchar";
            data: "run_created" | "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "attr_set" | "step_created" | "step_completed" | "step_failed" | "step_retrying" | "step_started" | "hook_created" | "hook_received" | "hook_disposed" | "hook_conflict" | "wait_created" | "wait_completed";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
            $type: "run_created" | "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "attr_set" | "step_created" | "step_completed" | "step_failed" | "step_retrying" | "step_started" | "hook_created" | "hook_received" | "hook_disposed" | "hook_conflict" | "wait_created" | "wait_completed";
        }>;
        correlationId: import("drizzle-orm/pg-core").PgColumn<{
            name: "correlation_id";
            tableName: "workflow_events";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_events";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_events";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        eventDataJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload";
            tableName: "workflow_events";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        eventData: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload_cbor";
            tableName: "workflow_events";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: unknown;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        specVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "spec_version";
            tableName: "workflow_events";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
/**
 * Which runs are slot-numbered. A row exists iff the run is, so its absence is
 * exactly the "this run predates slots, keep minting ULIDs" signal — no scan of
 * the event log is needed to tell the two schemes apart.
 *
 * A marker, not a counter. Positions are allocated by the insert that occupies
 * them (`MAX(slot) + 1` read from the log inside the INSERT), so nothing is
 * handed out ahead of the write that uses it and a write that fails leaves the
 * position free for the next one. A counter here would instead burn a position
 * per failed write, and every such hole is permanent.
 */
export declare const eventSlots: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_event_slots";
    schema: "workflow";
    columns: {
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_event_slots";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "pg";
}>;
export declare const steps: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_steps";
    schema: "workflow";
    columns: {
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_steps";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        stepId: import("drizzle-orm/pg-core").PgColumn<{
            name: "step_id";
            tableName: "workflow_steps";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        stepName: import("drizzle-orm/pg-core").PgColumn<{
            name: "step_name";
            tableName: "workflow_steps";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "workflow_steps";
            dataType: "string";
            columnType: "PgEnumColumn";
            data: "pending" | "running" | "completed" | "failed" | "cancelled";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pending" | "running" | "completed" | "failed" | "cancelled", ...("pending" | "running" | "completed" | "failed" | "cancelled")[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        inputJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "input";
            tableName: "workflow_steps";
            dataType: "json";
            columnType: "PgJsonb";
            data: SerializedContent;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: SerializedContent;
        }>;
        input: import("drizzle-orm/pg-core").PgColumn<{
            name: "input_cbor";
            tableName: "workflow_steps";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: SerializedContent;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        outputJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "output";
            tableName: "workflow_steps";
            dataType: "json";
            columnType: "PgJsonb";
            data: SerializedContent;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: SerializedContent;
        }>;
        output: import("drizzle-orm/pg-core").PgColumn<{
            name: "output_cbor";
            tableName: "workflow_steps";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: SerializedContent;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        errorJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "error";
            tableName: "workflow_steps";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        error: import("drizzle-orm/pg-core").PgColumn<{
            name: "error_cbor";
            tableName: "workflow_steps";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: unknown;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        attempt: import("drizzle-orm/pg-core").PgColumn<{
            name: "attempt";
            tableName: "workflow_steps";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "workflow_steps";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "workflow_steps";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_steps";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "workflow_steps";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        retryAfter: import("drizzle-orm/pg-core").PgColumn<{
            name: "retry_after";
            tableName: "workflow_steps";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        specVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "spec_version";
            tableName: "workflow_steps";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const hooks: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_hooks";
    schema: "workflow";
    columns: {
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        hookId: import("drizzle-orm/pg-core").PgColumn<{
            name: "hook_id";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        token: import("drizzle-orm/pg-core").PgColumn<{
            name: "token";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        projectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "project_id";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        environment: import("drizzle-orm/pg-core").PgColumn<{
            name: "environment";
            tableName: "workflow_hooks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_hooks";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tokenRetentionUntil: import("drizzle-orm/pg-core").PgColumn<{
            name: "token_retention_until";
            tableName: "workflow_hooks";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        metadataJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "metadata";
            tableName: "workflow_hooks";
            dataType: "json";
            columnType: "PgJsonb";
            data: SerializedContent;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: SerializedContent;
        }>;
        metadata: import("drizzle-orm/pg-core").PgColumn<{
            name: "metadata_cbor";
            tableName: "workflow_hooks";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: SerializedContent;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        specVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "spec_version";
            tableName: "workflow_hooks";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        isWebhook: import("drizzle-orm/pg-core").PgColumn<{
            name: "is_webhook";
            tableName: "workflow_hooks";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        isSystem: import("drizzle-orm/pg-core").PgColumn<{
            name: "is_system";
            tableName: "workflow_hooks";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resumeContext: import("drizzle-orm/pg-core").PgColumn<{
            name: "resume_context";
            tableName: "workflow_hooks";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: {
                deploymentId: string;
                workflowName: string;
                runSpecVersion?: number | undefined;
                workflowCoreVersion?: string | undefined;
                traceCarrier?: Record<string, string> | undefined;
                encryptionPublicKey?: string | undefined;
                hookResumeInputVersion?: number | undefined;
            };
            driverParam: Buffer<ArrayBufferLike>;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
    };
    dialect: "pg";
}>;
export declare const waits: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_waits";
    schema: "workflow";
    columns: {
        waitId: import("drizzle-orm/pg-core").PgColumn<{
            name: "wait_id";
            tableName: "workflow_waits";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_waits";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "workflow_waits";
            dataType: "string";
            columnType: "PgEnumColumn";
            data: "completed" | "waiting";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["completed" | "waiting", ...("completed" | "waiting")[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resumeAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "resume_at";
            tableName: "workflow_waits";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "workflow_waits";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_waits";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "workflow_waits";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        specVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "spec_version";
            tableName: "workflow_waits";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const streams: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "workflow_stream_chunks";
    schema: "workflow";
    columns: {
        chunkId: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "workflow_stream_chunks";
            dataType: "string";
            columnType: "PgVarchar";
            data: `chnk_${string}`;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
            $type: `chnk_${string}`;
        }>;
        streamId: import("drizzle-orm/pg-core").PgColumn<{
            name: "stream_id";
            tableName: "workflow_stream_chunks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "workflow_stream_chunks";
            dataType: "string";
            columnType: "PgVarchar";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        chunkData: import("drizzle-orm/pg-core").PgColumn<{
            name: "data";
            tableName: "workflow_stream_chunks";
            dataType: "custom";
            columnType: "PgCustomColumn";
            data: Buffer<ArrayBufferLike>;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            pgColumnBuilderBrand: "PgCustomColumnBuilderBrand";
        }>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "workflow_stream_chunks";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        eof: import("drizzle-orm/pg-core").PgColumn<{
            name: "eof";
            tableName: "workflow_stream_chunks";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
//# sourceMappingURL=schema.d.ts.map