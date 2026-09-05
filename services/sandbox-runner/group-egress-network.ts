/** Each external group shares a network only with its proxy, never with trusted or other-group compute. */
import type Docker from "dockerode";

const GROUP_NETWORK_LABEL = "dev.osinara.group-egress.workspace";
const PROJECT_LABEL = "dev.osinara.group-egress.project";

export function groupNetworkName(project: string, workspaceId: string): string {
  return `${project}-group-egress-${workspaceId}`;
}

export async function ensureGroupNetwork(docker: Docker, project: string, workspaceId: string): Promise<string> {
  const name = groupNetworkName(project, workspaceId);
  let network = docker.getNetwork(name);
  let info: Docker.NetworkInspectInfo;
  try {
    info = await network.inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    network = await docker.createNetwork({
      Name: name, Driver: "bridge", Internal: true, EnableIPv6: false,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { [GROUP_NETWORK_LABEL]: workspaceId, [PROJECT_LABEL]: project },
    });
    info = await network.inspect();
  }
  if (!info.Internal || info.Driver !== "bridge" || info.EnableIPv6 ||
      info.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
      info.Labels?.[GROUP_NETWORK_LABEL] !== workspaceId || info.Labels?.[PROJECT_LABEL] !== project) {
    throw new Error("AGENT_SANDBOX_GROUP_NETWORK_INVALID: Network identity or isolation does not match the group");
  }
  const proxies = await docker.listContainers({ filters: { label: [
    `com.docker.compose.project=${project}`, "com.docker.compose.service=sandbox-egress-proxy",
  ] } });
  if (proxies.length !== 1) throw new Error("AGENT_SANDBOX_GROUP_PROXY_MISSING: Expected one running egress proxy");
  const proxy = proxies[0]!;
  if (!info.Containers?.[proxy.Id]) {
    await network.connect({ Container: proxy.Id, EndpointConfig: { Aliases: ["sandbox-egress-proxy"] } });
  }
  return name;
}

export async function removeUnusedGroupNetwork(docker: Docker, project: string, workspaceId: string): Promise<void> {
  const network = docker.getNetwork(groupNetworkName(project, workspaceId));
  let info: Docker.NetworkInspectInfo;
  try { info = await network.inspect(); }
  catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error; }
  if (info.Labels?.[GROUP_NETWORK_LABEL] !== workspaceId || info.Labels?.[PROJECT_LABEL] !== project) {
    throw new Error("AGENT_SANDBOX_GROUP_NETWORK_INVALID: Refusing to remove a foreign network");
  }
  const containers = Object.keys(info.Containers ?? {});
  const proxies = await docker.listContainers({ all: true, filters: { label: [
    `com.docker.compose.project=${project}`, "com.docker.compose.service=sandbox-egress-proxy",
  ] } });
  const proxyIds = new Set(proxies.map((proxy) => proxy.Id));
  if (containers.some((id) => !proxyIds.has(id))) return;
  for (const id of containers) await network.disconnect({ Container: id, Force: true });
  await network.remove();
}

export async function cleanupGroupNetworks(
  docker: Docker,
  project: string,
  serialize: (key: string, operation: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const networks = await docker.listNetworks({ filters: { label: [`${PROJECT_LABEL}=${project}`] } });
  for (const network of networks) {
    const workspaceId = network.Labels?.[GROUP_NETWORK_LABEL];
    if (workspaceId) await serialize(`network:${workspaceId}`, () => removeUnusedGroupNetwork(docker, project, workspaceId));
  }
}
