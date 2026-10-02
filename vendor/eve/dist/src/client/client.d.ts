import { ClientSessions } from "#client/sessions.js";
import type { AgentInfoResult, ClientOptions, HealthResult } from "#client/types.js";
/**
 * HTTP client for talking to a deployed eve agent.
 *
 * A single client is bound to one host and auth configuration. Its
 * `sessions` collection can create or attach many independent fixed session
 * handles.
 */
export declare class Client {
    #private;
    /** Explicit create/attach surface for ID-addressed sessions. */
    readonly sessions: ClientSessions;
    constructor(options: ClientOptions);
    /**
     * Checks the health of the eve agent server.
     *
     * @throws {ClientError} If the server returns a non-successful status.
     */
    health(): Promise<HealthResult>;
    /**
     * Fetches the agent inspection payload from `GET /eve/v1/info`.
     *
     * The dev TUI uses it to render its startup header. Remote deployments
     * require whatever auth the info route accepts, which defaults to Vercel
     * OIDC outside local development.
     *
     * @throws {ClientError} If the server returns a non-successful status.
     * @throws {AgentInfoResponseError} If an authorized response carries a body
     * that is not a recognized agent-info payload (not JSON, or a mismatched
     * shape). Inspection is best-effort: a working connection does not depend on
     * this route, so connection probes treat this distinctly from a failed request.
     */
    info(): Promise<AgentInfoResult>;
    /**
     * Performs an authenticated fetch against a path on this eve target.
     *
     * This is the raw escape hatch for framework-owned routes (for example
     * channel ingress or dev-only schedule dispatch) while preserving the same
     * auth/header cascade used by {@link health}, {@link info}, and sessions.
     */
    fetch(path: string, init?: RequestInit): Promise<Response>;
}
