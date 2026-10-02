import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { AgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { type GatewayCredentialPresence } from "#internal/resolve-model-endpoint-status.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";
export declare function buildAgentInfoResponseFromManifest(data: AgentInfoManifestData, input: {
    readonly mode: AgentInfoResponse["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
    readonly chatgptAuth?: ChatGptAuthState;
}): AgentInfoResponse;
