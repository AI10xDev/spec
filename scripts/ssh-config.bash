# Shared by the local launchers; source this file from Bash.
spec_normalize_key() {
  if [[ -n "${SPEC_SSH_KEY:-}" ]]; then
    local key="$SPEC_SSH_KEY"
    case "$key" in
      '~/'*) key="$HOME/${key:2}" ;;
    esac
    if [[ ! -f "$key" || ! -r "$key" ]]; then
      printf 'SPEC_SSH_KEY is not a readable local private-key file: %s\n' "$key" >&2
      printf 'Set it to an existing key on this computer, or leave it empty to use SSH config/ssh-agent.\n' >&2
      return 1
    fi
    SPEC_SSH_KEY="$(realpath -e -- "$key")" || return
    export SPEC_SSH_KEY
  else
    unset SPEC_SSH_KEY
  fi
}

spec_configure_remote() {
  if [[ -z "${SPEC_SSH_TARGET:-}" ]]; then
    if [[ ! -r "$HOME/ip" ]]; then
      printf 'Write the remote host IP to ~/ip or set SPEC_SSH_TARGET=user@host.\n' >&2
      return 1
    fi
    local host
    host="$(<"$HOME/ip")"
    host="${host%$'\r'}"
    if [[ ! "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]]; then
      printf '~/ip must contain a single host name or IP address.\n' >&2
      return 1
    fi
    SPEC_SSH_TARGET="opencode@$host"
  fi
  if [[ "$SPEC_SSH_TARGET" == -* || "$SPEC_SSH_TARGET" == *[!a-zA-Z0-9_.@:\[\]-]* ]]; then
    printf 'SPEC_SSH_TARGET must be user@host or an SSH host alias.\n' >&2
    return 1
  fi
  export SPEC_SSH_TARGET
  # An explicitly empty value selects SSH config/ssh-agent.
  export SPEC_SSH_KEY="${SPEC_SSH_KEY-$HOME/Downloads/Spec_man.pem}"
  spec_normalize_key || return
  spec_ssh=("${SPEC_SSH_BINARY:-/usr/bin/ssh}" -T
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10
    -o ServerAliveInterval=15 -o ServerAliveCountMax=2
    -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no
    -o PermitLocalCommand=no -o ControlMaster=no -o ControlPath=none
    -o RemoteCommand=none -o StdinNull=no -o ForkAfterAuthentication=no
    -o SessionType=default)
  if [[ -n "${SPEC_SSH_KEY:-}" ]]; then
    spec_ssh+=(-i "$SPEC_SSH_KEY" -o IdentitiesOnly=yes)
  fi
  spec_ssh+=(-- "$SPEC_SSH_TARGET")
}

# SSH joins command arguments as shell code, so quote values explicitly.
spec_shell_quote() {
  printf "'%s'" "${1//\'/\'\"\'\"\'}"
}

spec_prepare_remote() {
  local directory="${SPEC_SSH_WORKSPACE:-}"
  if [[ -n "$directory" && ( "$directory" != /* || "$directory" =~ [[:cntrl:]] ) ]]; then
    printf 'SPEC_SSH_WORKSPACE must be an absolute remote directory.\n' >&2
    return 1
  fi
  SPEC_SSH_WORKSPACE="$("${spec_ssh[@]}" "bash -s -- $(spec_shell_quote "$directory")" <<'REMOTE'
set -euo pipefail
umask 077
directory="${1:-$HOME/project}"
mkdir -p -- "$directory"
cd -- "$directory"
pwd -P
REMOTE
  )" || return
  export SPEC_SSH_WORKSPACE
}
