#!/bin/bash
# Canonical GitHub release, manifest, and resolved Compose validation.
# Binds exact Compose bytes and image digests before any released configuration reaches Docker.

readonly GITHUB_REPOSITORY="ilkruglov/osinara"
readonly GITHUB_API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
readonly GITHUB_RELEASES="https://github.com/${GITHUB_REPOSITORY}/releases/download"
readonly APP_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-app@sha256:"
readonly CLI_PROXY_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-cli-proxy@sha256:"
readonly EDGE_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-edge@sha256:"
readonly EGRESS_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-sandbox-egress-proxy@sha256:"
readonly RUNNER_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-sandbox-runner@sha256:"
readonly RUNTIME_IMAGE_PREFIX="ghcr.io/ilkruglov/osinara-sandbox-runtime@sha256:"
readonly POSTGRES_IMAGE="pgvector/pgvector:pg17@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0"
readonly TEI_IMAGE="ghcr.io/huggingface/text-embeddings-inference:cpu-1.9@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07"
readonly RETAINED_LOCAL_RELEASE_IMAGE_COUNT=2
readonly RELEASE_DIRECTORY_NAME_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

curl_github() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --header 'User-Agent: osinara-production-deploy/1' "$@"
}

require_image_ref() {
  local value="$1"
  local prefix="$2"
  local digest="${value#"$prefix"}"
  [[ "$value" == "$prefix"* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail "DEPLOY_IMAGE_REFERENCE_INVALID" "Manifest contains an unexpected image reference"
}

is_release_image_variable() {
  local candidate="$1"
  local variable
  for variable in "${RELEASE_IMAGE_VARIABLES[@]}"; do
    [[ "$candidate" == "$variable" ]] && return 0
  done
  return 1
}

release_image_refs_from_env() {
  local env_file="$1"
  local key value
  [[ -f "$env_file" ]] || return 0
  while IFS='=' read -r key value; do
    if is_release_image_variable "$key" && [[ "$value" == ghcr.io/ilkruglov/osinara-*@sha256:* ]]; then
      printf '%s\n' "$value"
    fi
  done < "$env_file"
}

# Keeps the images of the newest `retained` installed releases (default: current and previous).
# Before the pull it runs with 1: three image sets and a backup no longer fit the disk otherwise.
prune_retired_release_images() {
  local retained="${1:-$RETAINED_LOCAL_RELEASE_IMAGE_COUNT}"
  [[ -d "$RELEASES_DIR" ]] || return 0
  local -a release_dirs=()
  local name path release_count retained_start index ref release_name release_prunable
  declare -A retained_refs=()

  # Release directories are sorted by SemVer so v0.2.10 is newer than v0.2.9.
  while IFS=$'\t' read -r name path; do
    [[ "$name" =~ $RELEASE_DIRECTORY_NAME_PATTERN ]] && release_dirs+=("$path")
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\t%p\n' | sort -V)

  release_count=${#release_dirs[@]}
  ((release_count > retained)) || return 0
  retained_start=$((release_count - retained))
  for ((index = retained_start; index < release_count; index += 1)); do
    while IFS= read -r ref; do
      retained_refs["$ref"]=1
    done < <(release_image_refs_from_env "${release_dirs[index]}/release.env")
  done

  for ((index = 0; index < retained_start; index += 1)); do
    release_name="${release_dirs[index]##*/}"
    release_prunable=1
    while IFS= read -r ref; do
      [[ -n "${retained_refs[$ref]+retained}" ]] && continue
      if docker image inspect "$ref" >/dev/null 2>&1; then
        # Image cache cleanup is post-success housekeeping; an in-use ref is logged and kept.
        if docker image rm "$ref" >/dev/null 2>&1; then
          log_event "DEPLOY_RELEASE_IMAGE_PRUNED" "Removed retired ${release_name} image reference"
        else
          log_event "DEPLOY_RELEASE_IMAGE_PRUNE_SKIPPED" "Could not remove retired ${release_name} image reference"
          release_prunable=0
        fi
      fi
    done < <(release_image_refs_from_env "${release_dirs[index]}/release.env")
    if [[ "$release_prunable" -eq 1 ]]; then
      rm -rf -- "${release_dirs[index]}" ||
        fail "DEPLOY_RELEASE_DIRECTORY_PRUNE_FAILED" "Could not remove retired release directory: ${release_name}"
      log_event "DEPLOY_RELEASE_DIRECTORY_PRUNED" "Removed retired release directory: ${release_name}"
    fi
  done
}

# The host controller (this script and its modules) is only ever written by the installer, so a
# fix in scripts/production-deploy never reached a running installation. The release's own
# installation archive carries the controller; it is trusted exactly like the manifest and the
# Compose file (the same immutable release over TLS), and bound to the approved manifest by the
# manifest copy the archive embeds. Staged here, installed by `install_controller_scripts` as the
# last act of a healthy deploy.
readonly CONTROLLER_FILES=(
  "production-deploy.sh"
  "production-deploy/common.sh"
  "production-deploy/database.sh"
  "production-deploy/release.sh"
  "production-deploy/backup.sh"
)
CONTROLLER_STAGE_DIR=""

stage_controller_scripts() {
  local archive="$1"
  local approved_manifest="$2"
  local stage="${WORK_DIR}/controller"
  local name
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions \
    "installation/osinara-deployment.json" "${CONTROLLER_FILES[@]/#/installation/}" ||
    fail "DEPLOY_CONTROLLER_ARCHIVE_INVALID" "Installation archive does not carry the controller"
  cmp --silent "${stage}/installation/osinara-deployment.json" "$approved_manifest" ||
    fail "DEPLOY_CONTROLLER_MANIFEST_MISMATCH" "Installation archive embeds another manifest"
  for name in "${CONTROLLER_FILES[@]}"; do
    [[ -f "${stage}/installation/${name}" && ! -L "${stage}/installation/${name}" ]] &&
      [[ "$(head -c 11 "${stage}/installation/${name}")" == "#!/bin/bash" ]] ||
      fail "DEPLOY_CONTROLLER_ARCHIVE_INVALID" "Controller file ${name} is missing or not a bash script"
  done
  CONTROLLER_STAGE_DIR="${stage}/installation"
}

install_controller_scripts() {
  [[ -n "$CONTROLLER_STAGE_DIR" ]] ||
    fail "DEPLOY_CONTROLLER_NOT_STAGED" "Controller scripts were not staged"
  local name mode temporary
  for name in "${CONTROLLER_FILES[@]}"; do
    cmp --silent "${CONTROLLER_STAGE_DIR}/${name}" "${BIN_DIR}/${name}" && continue
    mode=0640
    [[ "$name" == "production-deploy.sh" ]] && mode=0750
    temporary="${BIN_DIR}/${name}.pending.$$"
    # A rename gives bash a new inode: the running entrypoint keeps reading its old one.
    install -m "$mode" "${CONTROLLER_STAGE_DIR}/${name}" "$temporary" &&
      mv -f "$temporary" "${BIN_DIR}/${name}" ||
      fail "DEPLOY_CONTROLLER_INSTALL_FAILED" "Could not install controller file ${name}"
    log_event "DEPLOY_CONTROLLER_UPDATED" "${name}"
  done
}

validate_manifest() {
  local manifest="$1"
  local version="$2"
  jq -e --arg version "$version" '
    type == "object" and
    keys == ["commitSha", "composeSha256", "images", "schemaVersion", "version"] and
    .schemaVersion == 1 and .version == $version and
    (.commitSha | test("^[0-9a-f]{40}$")) and
    (.composeSha256 | test("^[0-9a-f]{64}$")) and
    (.images | type == "object" and
      keys == ["app", "cliProxy", "edge", "sandboxEgressProxy", "sandboxRunner", "sandboxRuntime"])
  ' "$manifest" >/dev/null || fail "DEPLOY_MANIFEST_INVALID" "Deployment manifest schema is invalid"

  MANIFEST_COMMIT="$(jq -er '.commitSha' "$manifest")"
  MANIFEST_COMPOSE_SHA="$(jq -er '.composeSha256' "$manifest")"
  APP_IMAGE="$(jq -er '.images.app' "$manifest")"
  CLI_PROXY_IMAGE="$(jq -er '.images.cliProxy' "$manifest")"
  EDGE_IMAGE="$(jq -er '.images.edge' "$manifest")"
  EGRESS_IMAGE="$(jq -er '.images.sandboxEgressProxy' "$manifest")"
  RUNNER_IMAGE="$(jq -er '.images.sandboxRunner' "$manifest")"
  RUNTIME_IMAGE="$(jq -er '.images.sandboxRuntime' "$manifest")"
  require_image_ref "$APP_IMAGE" "$APP_IMAGE_PREFIX"
  require_image_ref "$CLI_PROXY_IMAGE" "$CLI_PROXY_IMAGE_PREFIX"
  require_image_ref "$EDGE_IMAGE" "$EDGE_IMAGE_PREFIX"
  require_image_ref "$EGRESS_IMAGE" "$EGRESS_IMAGE_PREFIX"
  require_image_ref "$RUNNER_IMAGE" "$RUNNER_IMAGE_PREFIX"
  require_image_ref "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PREFIX"

  if {
    [[ "$STORED_VERSION" != "$version" || "$STORED_COMMIT" != "$MANIFEST_COMMIT" ||
       "$STORED_COMPOSE_SHA" != "$MANIFEST_COMPOSE_SHA" || "$STORED_APP" != "$APP_IMAGE" ||
       "$STORED_CLI_PROXY" != "$CLI_PROXY_IMAGE" || "$STORED_EDGE" != "$EDGE_IMAGE" ||
       "$STORED_EGRESS" != "$EGRESS_IMAGE" ||
       "$STORED_RUNNER" != "$RUNNER_IMAGE" || "$STORED_RUNTIME" != "$RUNTIME_IMAGE" ]];
  }; then
    fail "DEPLOY_APPROVED_MANIFEST_MISMATCH" "Public manifest differs from approved bytes"
  fi
}

verify_compose_hash() {
  local compose="$1"
  printf '%s  %s\n' "$MANIFEST_COMPOSE_SHA" "$compose" |
    sha256sum --check --status - ||
    fail "DEPLOY_COMPOSE_HASH_MISMATCH" "compose.production.yaml does not match composeSha256"
}

download_and_validate_release() {
  local version="$1"
  local tag="v${version}"
  local release_json="${WORK_DIR}/release.json"
  local ref_json="${WORK_DIR}/tag-ref.json"
  local tag_json="${WORK_DIR}/tag.json"
  local manifest="${WORK_DIR}/osinara-deployment.json"
  local compose="${WORK_DIR}/compose.production.yaml"
  local archive="${WORK_DIR}/osinara-installation.tar.gz"

  curl_github --output "$release_json" "${GITHUB_API}/releases/tags/${tag}"
  jq -e --arg tag "$tag" --arg base "${GITHUB_RELEASES}/${tag}" '
    .tag_name == $tag and .immutable == true and .draft == false and .prerelease == false and
    ([.assets[] | select(.name == "osinara-deployment.json" and
      .browser_download_url == ($base + "/osinara-deployment.json"))] | length == 1) and
    ([.assets[] | select(.name == "compose.production.yaml" and
      .browser_download_url == ($base + "/compose.production.yaml"))] | length == 1) and
    ([.assets[] | select(.name == "osinara-installation.tar.gz" and
      .browser_download_url == ($base + "/osinara-installation.tar.gz"))] | length == 1)
  ' "$release_json" >/dev/null ||
    fail "DEPLOY_RELEASE_METADATA_INVALID" "Public release metadata is invalid"
  curl_github --output "$manifest" "${GITHUB_RELEASES}/${tag}/osinara-deployment.json"
  curl_github --output "$compose" "${GITHUB_RELEASES}/${tag}/compose.production.yaml"
  curl_github --output "$archive" "${GITHUB_RELEASES}/${tag}/osinara-installation.tar.gz"
  validate_manifest "$manifest" "$version"
  verify_compose_hash "$compose"
  stage_controller_scripts "$archive" "$manifest"

  curl_github --output "$ref_json" "${GITHUB_API}/git/ref/tags/${tag}"
  local object_type object_sha
  object_type="$(jq -er '.object.type' "$ref_json")"
  object_sha="$(jq -er '.object.sha' "$ref_json")"
  if [[ "$object_type" == "tag" ]]; then
    curl_github --output "$tag_json" "${GITHUB_API}/git/tags/${object_sha}"
    object_type="$(jq -er '.object.type' "$tag_json")"
    object_sha="$(jq -er '.object.sha' "$tag_json")"
  fi
  [[ "$object_type" == "commit" && "$object_sha" == "$MANIFEST_COMMIT" ]] ||
    fail "DEPLOY_RELEASE_COMMIT_MISMATCH" "Release tag does not match manifest.commitSha"
}

require_upgrade_from_current() {
  local current_version
  current_version="$(jq -er '.version' "$CURRENT_MANIFEST")"
  require_semver "$current_version"
  version_is_greater "$REQUESTED_VERSION" "$current_version" ||
    fail "DEPLOY_DOWNGRADE_FORBIDDEN" \
      "Requested version ${REQUESTED_VERSION} is not newer than ${current_version}"
}

prepare_candidate_release() {
  [[ ! -e "${RELEASES_DIR}/v${REQUESTED_VERSION}" ]] ||
    fail "DEPLOY_RELEASE_DIR_EXISTS" "Final release directory already exists"
  CANDIDATE_DIR="$(mktemp -d "${WORK_DIR}/candidate.XXXXXX")"
  install -m 0644 "${WORK_DIR}/compose.production.yaml" "${CANDIDATE_DIR}/compose.production.yaml"
  install -m 0644 "${WORK_DIR}/osinara-deployment.json" \
    "${CANDIDATE_DIR}/osinara-deployment.json"
  CANDIDATE_COMPOSE="${CANDIDATE_DIR}/compose.installation.json"
  CANDIDATE_ENV="${CANDIDATE_DIR}/release.env"
  {
    printf 'OSINARA_APP_IMAGE=%s\n' "$APP_IMAGE"
    printf 'OSINARA_CLI_PROXY_IMAGE=%s\n' "$CLI_PROXY_IMAGE"
    printf 'SANDBOX_RUNTIME_IMAGE=%s\n' "$RUNTIME_IMAGE"
    printf 'OSINARA_SANDBOX_RUNNER_IMAGE=%s\n' "$RUNNER_IMAGE"
    printf 'OSINARA_SANDBOX_EGRESS_PROXY_IMAGE=%s\n' "$EGRESS_IMAGE"
    printf 'OSINARA_EDGE_IMAGE=%s\n' "$EDGE_IMAGE"
  } > "$CANDIDATE_ENV"
  chmod 0600 "$CANDIDATE_ENV"
  docker compose --env-file "$SERVER_ENV" --env-file "$CANDIDATE_ENV" \
    -f "${CANDIDATE_DIR}/compose.production.yaml" config --no-interpolate --format json > "${CANDIDATE_DIR}/compose.full.json"
  # Preserve an installed subscription gateway; direct-provider installations do not acquire one.
  if jq -e '.services | has("cli-proxy-api")' "$CURRENT_COMPOSE" >/dev/null; then
    cp "${CANDIDATE_DIR}/compose.full.json" "$CANDIDATE_COMPOSE"
  else
    jq 'del(.services["cli-proxy-api"], .services.agent.depends_on["cli-proxy-api"], .volumes["cli-proxy-auth"])' \
      "${CANDIDATE_DIR}/compose.full.json" > "$CANDIDATE_COMPOSE"
  fi
  validate_resolved_compose
}

validate_resolved_compose_security() {
  local config_json="$1"
  jq -e '
    all(.services[]; (.privileged // false) == false) and
    all(.services[]; (.network_mode // "") != "host") and
    all(.services[]; (.pid // "") != "host") and
    all(.services[]; (.ipc // "") != "host") and
    all(.services[]; (has("build") or has("devices") or has("cap_add") or has("volumes_from")) | not) and
    all(.services[]; .logging.driver == "json-file" and
      .logging.options["max-size"] == "20m" and .logging.options["max-file"] == "5") and
    ((.services.edge.networks // {}) | keys) == ["app-network", "edge-frontend"] and
    ([.services | to_entries[] |
      select((.value.networks // {}) | has("edge-frontend")) | .key] | sort) == ["edge"] and
    any(.services.agent.volumes[];
      .source == "/opt/osinara/agent-model-providers.json" and
      .target == "/app/config/agent-model-providers.json" and .read_only == true) and
    (if .services | has("cli-proxy-api") then
      any(.services["cli-proxy-api"].volumes[];
        .source == "cli-proxy-auth" and .target == "/var/lib/cli-proxy-api/auth" and .type == "volume")
      else true end) and
    ([.services | to_entries[] as $service |
      ($service.value.volumes // [])[] |
      {service: $service.key, type, source, target}] | sort_by(.service, .target)) == ([
        {service: "agent", type: "volume", source: "sandbox-data", target: "/app/.eve/sandbox-cache"},
        {service: "agent", type: "volume", source: "google-workspace-credentials", target: "/app/google-workspace-credentials"},
        {service: "agent", type: "volume", source: "workspace-data", target: "/app/workspaces"},
        {service: "agent", type: "bind", source: "/opt/osinara/agent-model-providers.json", target: "/app/config/agent-model-providers.json"},
        {service: "memory-embedding", type: "volume", source: "memory-embedding-model-e5", target: "/data"},
        {service: "memory-reranker", type: "volume", source: "memory-reranker-model-minilm", target: "/data"},
        {service: "postgres", type: "volume", source: "postgres-data", target: "/var/lib/postgresql/data"},
        {service: "sandbox-runner", type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock"},
        {service: "sandbox-runner", type: "volume", source: "tool-environments", target: "/runner/tools"},
        {service: "sandbox-runner", type: "volume", source: "workspace-data", target: "/runner/workspaces"}
      ] + (if .services | has("cli-proxy-api") then
        [{service: "cli-proxy-api", type: "volume", source: "cli-proxy-auth", target: "/var/lib/cli-proxy-api/auth"}]
        else [] end) | sort_by(.service, .target)) and
    ([.services | to_entries[] as $service | ($service.value.ports // [])[] |
      {service: $service.key, host_ip, published, target}] == [{
        service: "edge", host_ip: "127.0.0.1", published: "8082", target: 80
      }])
  ' "$config_json" >/dev/null
}

validate_resolved_compose() {
  local images_file="${WORK_DIR}/resolved-images.txt"
  local expected_images_file="${WORK_DIR}/expected-images.txt"
  local config_json="${WORK_DIR}/resolved-compose.json"
  compose_candidate config --images | LC_ALL=C sort > "$images_file"
  {
    printf '%s\n' "$APP_IMAGE" "$APP_IMAGE" "$APP_IMAGE" "$APP_IMAGE" \
      "$RUNTIME_IMAGE" "$RUNNER_IMAGE" "$EGRESS_IMAGE" "$EDGE_IMAGE" "$POSTGRES_IMAGE" "$TEI_IMAGE" "$TEI_IMAGE"
    if jq -e '.services | has("cli-proxy-api")' "$CANDIDATE_COMPOSE" >/dev/null; then
      printf '%s\n' "$CLI_PROXY_IMAGE"
    fi
  } | LC_ALL=C sort > "$expected_images_file"
  cmp --silent "$images_file" "$expected_images_file" ||
    fail "DEPLOY_COMPOSE_IMAGE_SET_INVALID" "Resolved Compose image multiset is not approved"

  compose_candidate config --format json > "$config_json"
  jq -e '
    (.services | keys) == ([
      "agent", "edge", "memory-embedding", "memory-embedding-worker", "memory-reranker", "migrate", "postgres",
      "sandbox-egress-proxy", "sandbox-runner", "sandbox-runtime-image", "telegram-ingress-worker"
    ] + (if .services | has("cli-proxy-api") then ["cli-proxy-api"] else [] end) | sort) and
    .services.agent.depends_on.migrate.condition == "service_completed_successfully" and
    .services.agent.depends_on["memory-reranker"].condition == "service_healthy" and
    (if .services | has("cli-proxy-api") then
      .services.agent.depends_on["cli-proxy-api"].condition == "service_healthy" else true end)
  ' "$config_json" >/dev/null ||
    fail "DEPLOY_COMPOSE_SERVICE_SET_INVALID" "Resolved Compose service set is not approved"
  validate_resolved_compose_security "$config_json" ||
    fail "DEPLOY_COMPOSE_SECURITY_INVALID" "Resolved Compose enables an unsafe host capability"
}

pull_release_images() {
  compose_candidate pull --quiet
}

start_candidate_release() {
  compose_candidate up --detach --remove-orphans --no-build --wait --wait-timeout 600
}

promote_candidate_release() {
  local final_dir="${RELEASES_DIR}/v${REQUESTED_VERSION}"
  [[ ! -e "$final_dir" ]] ||
    fail "DEPLOY_RELEASE_DIR_EXISTS" "Final release directory already exists"
  mv "$CANDIDATE_DIR" "$final_dir"
  CANDIDATE_DIR="$final_dir"
  CANDIDATE_COMPOSE="${final_dir}/compose.installation.json"
  CANDIDATE_ENV="${final_dir}/release.env"
  local name temporary
  for name in compose.installation.json release.env osinara-deployment.json; do
    temporary="${BASE_DIR}/.${name}.pending.$$"
    install -m 0600 "${final_dir}/${name}" "$temporary"
    mv -f "$temporary" "${BASE_DIR}/${name}"
  done
  set_current_release_paths
}
