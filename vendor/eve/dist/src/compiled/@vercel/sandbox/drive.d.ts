import { Paginator } from "./utils/paginator.js";
import { DriveMetadata } from "./api-client/validators.js";
import { APIClient, WithFetchOptions } from "./api-client/api-client.js";
import "./api-client/index.js";
import { Credentials } from "./utils/get-credentials.js";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "./_workflow-serde.js";

//#region src/drive.d.ts
interface SerializedDrive {
  drive: DriveMetadata;
  projectId?: string;
}
/** @inline */
interface GetOrCreateDriveParams {
  /**
   * The name of the drive to get or create. Must be unique within the project.
   */
  name: string;
  /**
   * Maximum drive size in bytes. If omitted, a default of 100 GiB is used.
   */
  maxSize?: number;
  /**
   * An AbortSignal to cancel the operation.
   */
  signal?: AbortSignal;
}
/**
 * A Drive is a persistent, bottomless storage that can be attached and detached to Sandboxes.
 * Drives can be mounted as read-write or read-only, at a configurable path with `Sandbox.create()`.
 *
 * Use {@link Drive.getOrCreate} to construct.
 * @hideconstructor
 */
declare class Drive {
  private _client;
  private drive;
  private readonly _projectId;
  /**
   * Lazily resolve credentials and construct an API client.
   * @internal
   */
  private ensureClient;
  /**
   * The name of the drive.
   */
  get name(): string;
  /**
   * The project ID that owns the drive.
   */
  get projectId(): string;
  /**
   * The maximum drive size in bytes.
   */
  get maxSize(): number;
  /**
   * Current session ID the drive is attached to, if any.
   */
  get currentSessionId(): string | undefined;
  /**
   * Current sandbox name the drive is attached to, if any.
   */
  get currentSandboxName(): string | undefined;
  /**
   * Timestamp when the drive was created.
   */
  get createdAt(): Date;
  /**
   * Timestamp when the drive was last updated.
   */
  get updatedAt(): Date;
  /**
   * Serialize a Drive instance to plain data for @workflow/serde.
   *
   * @param instance - The Drive instance to serialize
   * @returns A plain object containing drive metadata
   */
  static [WORKFLOW_SERIALIZE](instance: Drive): SerializedDrive;
  /**
   * Deserialize a Drive from serialized data.
   *
   * The deserialized instance uses the serialized metadata synchronously and
   * lazily creates an API client only when methods perform API requests.
   *
   * @param data - The serialized drive data
   * @returns The reconstructed Drive instance
   */
  static [WORKFLOW_DESERIALIZE](data: SerializedDrive): Drive;
  constructor({
    client,
    drive,
    projectId
  }: {
    client?: APIClient;
    drive: DriveMetadata;
    projectId?: string;
  });
  /**
   * Allow to get a list of drives for a team narrowed to the given params.
   * It returns both the drives and the pagination metadata to allow getting
   * the next page of results.
   *
   * The returned object is async-iterable to auto-paginate through all pages:
   *
   * ```ts
   * const result = await Drive.list({ limit: 10 });
   * for await (const drive of result) { ... }
   * // or: await result.toArray();
   * // or: for await (const page of result.pages()) { ... }
   * ```
   */
  static list(params?: Partial<Parameters<APIClient["listDrives"]>[0]> & Partial<Credentials> & WithFetchOptions): Promise<Paginator<{
    drives: Drive[];
    pagination: {
      count: number;
      next: string | null;
    };
  }, "drives">>;
  /**
   * Retrieve an existing drive, or create a new one if it doesn't exists.
   *
   * @param params - Get/create parameters and optional credentials.
   * @returns A promise resolving to the {@link Drive}.
   */
  static getOrCreate(params: (GetOrCreateDriveParams | (GetOrCreateDriveParams & Credentials)) & WithFetchOptions): Promise<Drive>;
  /**
   * Delete this drive. The drive must not be attached to any sandbox.
   * This operation is irreversible and will delete all data stored in the drive.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves once the drive has been deleted.
   */
  delete(opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
}
//#endregion
export { Drive, SerializedDrive };
//# sourceMappingURL=drive.d.ts.map