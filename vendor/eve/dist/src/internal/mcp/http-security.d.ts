/**
 * Applies the fetch-native HTTP guards required in front of the MCP SDK.
 *
 * Non-browser clients normally omit `Origin`; browser requests are restricted
 * to the endpoint's exact origin. Plain HTTP is accepted only on loopback.
 */
export declare function validateMcpHttpRequest(request: Request): Response | undefined;
/**
 * Applies transport and Host validation to the public OAuth discovery route
 * without restricting its Origin. The route itself supplies permissive CORS.
 */
export declare function validateMcpMetadataRequest(request: Request): Response | undefined;
