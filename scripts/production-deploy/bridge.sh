#!/bin/bash
# One-time owner-approved v0.15.2 production model contract bridge.
# Derives the direct-provider credential from v0.15.1 and installs exact canonical release bytes.

readonly V0152_BRIDGE_SOURCE_VERSION="0.15.1"
readonly V0152_BRIDGE_TARGET_VERSION="0.15.2"
readonly V0152_MODEL_CONFIG_SHA256="4125a909ad3a2cfab08df5158538d210e2bcb753b3faa3a79f7be8a81bcf55c8"

validate_bridge_credential_assignment() {
  local value="$1"
  if [[ "$value" =~ ^\'[^\'[:space:]]+\'$ || "$value" =~ ^[^\'\"#[:space:]]+$ ]]; then
    return 0
  fi
  fail "DEPLOY_V0152_MODEL_KEY_INVALID" \
    "Legacy DeepSeek credential is empty or uses unsupported dotenv syntax"
}

read_bridge_credentials() {
  local line name value
  local legacy_count=0
  local model_count=0
  BRIDGE_LEGACY_VALUE=""
  BRIDGE_MODEL_VALUE=""

  # Parse only exact credential assignments; never source or evaluate secret-bearing dotenv bytes.
  while IFS= read -r line || [[ -n "$line" ]]; do
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      DEEPSEEK_API_KEY)
        legacy_count=$((legacy_count + 1))
        BRIDGE_LEGACY_VALUE="$value"
        ;;
      MODEL_API_KEY)
        model_count=$((model_count + 1))
        BRIDGE_MODEL_VALUE="$value"
        ;;
    esac
  done < "$SERVER_ENV"

  [[ "$legacy_count" -eq 1 ]] ||
    fail "DEPLOY_V0152_LEGACY_KEY_INVALID" \
      "v0.15.1 environment must contain exactly one DEEPSEEK_API_KEY assignment"
  [[ "$model_count" -le 1 ]] ||
    fail "DEPLOY_V0152_MODEL_KEY_INVALID" \
      "Environment must contain at most one MODEL_API_KEY assignment"
  validate_bridge_credential_assignment "$BRIDGE_LEGACY_VALUE"
  if [[ "$model_count" -eq 1 && "$BRIDGE_MODEL_VALUE" != "$BRIDGE_LEGACY_VALUE" ]]; then
    fail "DEPLOY_V0152_MODEL_KEY_CONFLICT" \
      "Existing MODEL_API_KEY does not exactly match the approved legacy DeepSeek credential"
  fi
  BRIDGE_MODEL_PRESENT="$model_count"
}

require_v0152_release_config() {
  local released_config="${WORK_DIR}/agent-model-providers.json"
  [[ -f "$released_config" && ! -L "$released_config" ]] ||
    fail "DEPLOY_V0152_MODEL_CONFIG_MISSING" \
      "Canonical v0.15.2 agent model config asset is absent"
  printf '%s  %s\n' "$V0152_MODEL_CONFIG_SHA256" "$released_config" |
    sha256sum --check --status - ||
    fail "DEPLOY_V0152_MODEL_CONFIG_HASH_MISMATCH" \
      "Canonical v0.15.2 agent model config does not match the reviewed bytes"
}

provision_v0152_model_bridge() {
  if [[ "$REQUESTED_VERSION" != "$V0152_BRIDGE_TARGET_VERSION" ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    return 0
  fi
  require_v0152_release_config

  # Initial installs must arrive with the new contract; only a claimed update may derive legacy state.
  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    cmp --silent "${WORK_DIR}/agent-model-providers.json" "$AGENT_MODEL_PROVIDER_CONFIG" ||
      fail "DEPLOY_V0152_MODEL_CONFIG_CONFLICT" \
        "Initial v0.15.2 model config differs from the canonical release asset"
    return 0
  fi

  local source_version
  source_version="$(jq -er '.version' "${CURRENT_LINK}/osinara-deployment.json")"
  if [[ "$source_version" != "$V0152_BRIDGE_SOURCE_VERSION" ]]; then
    fail "DEPLOY_V0152_BRIDGE_SOURCE_INVALID" \
      "Missing v0.15.2 model contract can be provisioned only from v0.15.1"
  fi
  read_bridge_credentials

  # Existing config is accepted only when it is byte-identical to the reviewed release artifact.
  if [[ -e "$AGENT_MODEL_PROVIDER_CONFIG" ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    cmp --silent "${WORK_DIR}/agent-model-providers.json" "$AGENT_MODEL_PROVIDER_CONFIG" ||
      fail "DEPLOY_V0152_MODEL_CONFIG_CONFLICT" \
        "Existing agent model config differs from the canonical v0.15.2 release asset"
  else
    local config_temp
    config_temp="$(mktemp "${WORK_DIR}/agent-model-providers.XXXXXX")"
    install -o root -g root -m 0644 "${WORK_DIR}/agent-model-providers.json" "$config_temp"
    mv -f "$config_temp" "$AGENT_MODEL_PROVIDER_CONFIG"
  fi

  # Preserve DEEPSEEK_API_KEY for v0.15.1 rollback and append the exact same dotenv token atomically.
  if [[ "$BRIDGE_MODEL_PRESENT" -eq 0 ]]; then
    local environment_temp
    environment_temp="$(mktemp "${WORK_DIR}/server-env.XXXXXX")"
    install -o root -g root -m 0600 "$SERVER_ENV" "$environment_temp"
    if [[ -n "$(tail -c 1 "$environment_temp")" ]]; then
      printf '\n' >> "$environment_temp"
    fi
    printf 'MODEL_API_KEY=%s\n' "$BRIDGE_LEGACY_VALUE" >> "$environment_temp"
    mv -f "$environment_temp" "$SERVER_ENV"
  fi
  require_metadata "$SERVER_ENV" "0:0:600"
  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
}
