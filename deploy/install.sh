#!/bin/bash
set -euo pipefail

readonly repository_url=https://github.com/jcore9/Aphelion.git
readonly root=/opt/aphelion
readonly credential=/etc/credstore.encrypted/aphelion-bootstrap

usage() {
  cat >&2 <<'USAGE'
usage: sudo bash -s -- --tag TAG [--no-start]
  --tag TAG    the release to install, for example v0.1.0-alpha.2
  --no-start   install but leave the service stopped, for a host that restores a backup next
USAGE
  exit 2
}

say() { echo "install: $*"; }

stop() {
  echo "install: $*" >&2
  exit 1
}

check_ufw() {
  local -a ufw
  mapfile -t ufw < <(sh -c 'for f; do [ -r "$f" ] && . "$f"; done >/dev/null 2>&1
    command printf "%s\n%s\nend\n" "${ENABLED-}" "${MANAGE_BUILTINS-}"' sh /etc/default/ufw /etc/ufw/ufw.conf)
  [[ ${ufw[2]-} == end ]] ||
    stop "reading /etc/default/ufw and /etc/ufw/ufw.conf with sh stopped early, so the ufw settings are unknown. Fix those files so sh can load them, then run this again"
  if [[ ${ufw[0]} =~ ^(yes|YES)$ && ${ufw[1]} == yes ]]; then
    stop "ufw is enabled with MANAGE_BUILTINS=yes and can remove Docker and Aphelion firewall rules. Set MANAGE_BUILTINS=no in /etc/default/ufw, run sudo ufw reload, then run this again"
  fi
}

check_root_owned() {
  local path=$1
  if [[ $(stat -c '%u' "$path") != 0 ]] || (($(stat -c '%a' "$path" | sed 's/^/8#/') & 8#022)); then
    stop "$path must be owned by root and writable only by root. Fix that, then run this again"
  fi
}

inspect_checkout() {
  [[ -e $root ]] || return 0
  [[ -d $root/.git ]] || stop "$root exists and isn't a clone of Aphelion. Move it away first"
  check_root_owned "$root"
  check_root_owned "$root/.git"
  local origin dirty tag_commit
  origin=$(git -C "$root" remote get-url origin 2>/dev/null) || origin=""
  [[ $origin == "$repository_url" ]] ||
    stop "$root isn't a clone of $repository_url (its origin is ${origin:-unknown}). Move it away first"
  dirty=$(git -C "$root" status --porcelain) ||
    stop "git status failed in $root, so the installer can't tell whether it has local changes"
  [[ -z $dirty ]] || stop "$root has local changes. Keep or undo them, then run this again"
  previous=$(git -C "$root" rev-parse HEAD) || stop "git can't read the commit that $root is on"
  tag_commit=$(git -C "$root" rev-parse "refs/tags/$tag^{commit}" 2>/dev/null) || tag_commit=""
  if [[ -n $tag_commit && $tag_commit == "$previous" ]]; then
    at_tag=1
  fi
}

install_docker() {
  if docker compose version >/dev/null 2>&1; then
    say "Docker with Compose is already installed"
    return
  fi
  say "installing Docker from Docker's Ubuntu repository"
  apt-get update -qq
  apt-get install -qq --yes ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL -o /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER
  apt-get update -qq
  apt-get install -qq --yes docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

show_recovery_key() {
  local existed=$1 answer=""
  exec 3</dev/tty 4>/dev/tty
  {
    echo
    if ((existed)); then
      echo "Aphelion keeps the key to its secrets store in $credential."
    else
      echo "Aphelion made the key to its secrets store in $credential."
    fi
    echo "If this host's disk is lost, a copy of the key is the only way to read the store on a new host."
    echo "systemd-creds may have said that its host key is not on encrypted media. Anyone who copies this whole disk can then decrypt the key."
    echo "The key is about to show on this screen. Make sure that nobody can see it. Press Enter to show it."
  } >&4
  read -r _ <&3 || stop "no answer from the terminal, so this stops before the recovery key"
  systemd-creds decrypt --name=bootstrap "$credential" - >&4
  echo "Save that line in your password manager, apart from any backup of the server." >&4
  until [[ $answer == saved ]]; do
    printf 'Type saved when you have it: ' >&4
    read -r answer <&3 || stop "no answer from the terminal, so the service isn't started. Run this again"
  done
  clear >&4 2>/dev/null || true
}

main() {
  local tag="" start=1 address at_tag=0 previous="" moved=0 existed=0
  while (($#)); do
    case $1 in
      --tag)
        (($# >= 2)) || usage
        tag=$2
        shift 2 ;;
      --no-start)
        start=0
        shift ;;
      *) usage ;;
    esac
  done
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage

  ((EUID == 0)) || stop "run this with sudo"
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || stop "this installer is for Ubuntu, and this host is ${PRETTY_NAME:-unknown}"

  if [[ $(uname -m) == x86_64 ]] && ! grep -qw sse4_2 /proc/cpuinfo; then
    stop "this processor hides sse4_2, which Bun needs. On a Proxmox VM, set the CPU type to host, stop the VM fully, and start it again. Then run this again."
  fi

  command -v tailscale >/dev/null || stop "install Tailscale and sign in first, then run this again"
  address=$(tailscale ip -4 2>/dev/null | head -n 1) || address=""
  if [[ ! $address =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    stop "Tailscale has no tailnet address for this host. Sign in to Tailscale, then run this again"
  fi
  say "Tailscale address $address"
  check_ufw

  inspect_checkout
  if systemctl is-active --quiet aphelion; then
    ((start)) || stop "aphelion.service is running, so --no-start can't leave it stopped. Stop it first with: sudo systemctl stop aphelion"
    if [[ -d $root/.git ]] && ((!at_tag)); then
      stop "aphelion.service is running, and $root isn't at $tag. Moving a running server to another release is the job of: sudo aphelion upgrade $tag (that command is still coming; until then follow Upgrade in the install guide)"
    fi
  fi

  export DEBIAN_FRONTEND=noninteractive
  for tool in git curl; do
    command -v "$tool" >/dev/null || { apt-get update -qq && apt-get install -qq --yes "$tool" ca-certificates; }
  done
  install_docker
  systemctl is-active --quiet docker || systemctl enable --now docker

  if [[ -d $root/.git ]]; then
    if ((at_tag)); then
      say "$root is already at $tag"
    else
      git -C "$root" fetch --tags --quiet origin
      git -C "$root" -c advice.detachedHead=false checkout --quiet "tags/$tag"
      moved=1
      say "moved $root to $tag"
    fi
  else
    git clone --quiet --branch "$tag" -c advice.detachedHead=false "$repository_url" "$root"
    say "cloned $tag to $root"
  fi

  local env_file=$root/deploy/.env
  if [[ -e $env_file ]]; then
    say "$env_file already exists, so it stays as it is"
  else
    (umask 022 && printf 'APHELION_TAILNET_ADDRESS=%s\n' "$address" >"$env_file")
    say "wrote $env_file"
  fi

  if ! "$root/deploy/host/get-image" "$tag"; then
    if ((moved)); then
      git -C "$root" -c advice.detachedHead=false checkout --quiet --detach "$previous"
      echo "install: moved $root back to $previous, where it was before" >&2
    fi
    exit 1
  fi

  [[ ! -e $credential ]] || existed=1
  "$root/deploy/host/install"

  if ((!start)); then
    say "--no-start: the service is installed and stays stopped. Start it with: sudo systemctl start aphelion"
    return
  fi
  if systemctl is-active --quiet aphelion; then
    say "aphelion.service is already running. Check it with: sudo aphelion check"
    return
  fi

  if ! (: </dev/tty) 2>/dev/null; then
    stop "no terminal, so this stops before the recovery key. Run: sudo systemd-creds decrypt --name=bootstrap $credential -
Save the line it prints in your password manager. Then run: sudo systemctl start aphelion"
  fi
  show_recovery_key "$existed"

  systemctl start aphelion ||
    stop "aphelion.service didn't start. The unit runs the preflight checks first. Read why with: sudo journalctl -u aphelion -e"
  say "started aphelion.service"
  echo "Next: check from another device on the tailnet: curl http://$address:7400/health"
  echo "Then add a device: sudo aphelion device add laptop"
}

main "$@"
