#!/usr/bin/env bash
# Launch a server with voice-only settings; never source or rewrite text settings.
set +x
set -euo pipefail

if (( $# < 4 )); then
  printf 'Usage: bash %s RESOURCE_GROUP RESOURCE DEPLOYMENT COMMAND [ARG...]\n' "$0" >&2
  exit 2
fi

group="$1"
resource="$2"
deployment="$3"
shift 3

if [[ -v SPEC_AZURE_REALTIME_ENV_FILE && -z "$SPEC_AZURE_REALTIME_ENV_FILE" ]]; then
  printf 'Unset SPEC_AZURE_REALTIME_ENV_FILE or supply a nonempty file path. Text settings were not changed.\n' >&2
  exit 1
fi

# Do not mix a local key with an endpoint fetched from a different Azure resource.
present=0
for name in AZURE_OPENAI_REALTIME_ENDPOINT AZURE_OPENAI_REALTIME_API_KEY AZURE_OPENAI_REALTIME_DEPLOYMENT; do
  if [[ -v "$name" ]]; then
    if [[ -z "${!name}" ]]; then
      printf 'Azure voice exports must not be empty. Text settings were not changed.\n' >&2
      exit 1
    fi
    present=$((present + 1))
  fi
done

if (( present == 0 )); then
  if [[ -n "${SPEC_AZURE_REALTIME_ENV_FILE:-}" ]]; then
    # Let the server read the explicitly selected private voice file instead.
    exec "$@"
  fi
  domain="$(az cognitiveservices account show --resource-group "$group" --name "$resource" \
    --query properties.customSubDomainName -o tsv --only-show-errors)"
  if [[ ! "$domain" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
    printf 'Azure resource has no supported OpenAI custom domain.\n' >&2
    exit 1
  fi
  key="$(az cognitiveservices account keys list --resource-group "$group" --name "$resource" \
    --query key1 -o tsv --only-show-errors)"
  if [[ -z "$key" || "$key" == null ]]; then
    printf 'Azure did not return a voice API key.\n' >&2
    exit 1
  fi
  export AZURE_OPENAI_REALTIME_ENDPOINT="https://$domain.openai.azure.com"
  export AZURE_OPENAI_REALTIME_API_KEY="$key"
  export AZURE_OPENAI_REALTIME_DEPLOYMENT="$deployment"
  unset key
elif (( present != 3 )); then
  printf 'Set all three AZURE_OPENAI_REALTIME_* exports, or unset all three to use Azure CLI.\n' >&2
  exit 1
fi

exec "$@"
