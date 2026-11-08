#!/bin/sh
# Boot the DSH Web profile with the AIOps bundle inside a container.
set -eu

DSH_HOME="${DSH_HOME:-/data}"
export DSH_HOME
mkdir -p "$DSH_HOME"

# First boot: copy the build-time-seeded profile so no network is needed.
if [ ! -d "$DSH_HOME/profiles/web" ]; then
  cp -a /opt/dsh-aiops-seed/. "$DSH_HOME/"
  # pnpm records link: installs as symlinks relative to the seed home; the
  # copy breaks them, so re-point the AIOps bundle at its absolute location.
  ln -sfn /opt/dsh-aiops "$DSH_HOME/profiles/web/node_modules/dsh-aiops"
fi

# `dsh web` and the webhook webserver reject wildcard bind addresses, so bind
# the container's primary interface address; published ports still reach it
# from the host.
HOST="$(hostname -i | awk '{print $1}')"
PORT="${DSH_WEB_PORT:-8080}"
AIOPS_WEBHOOK_HOST="$HOST"
export AIOPS_WEBHOOK_HOST

set -- --profile web --host "$HOST" --port "$PORT" --no-open
if [ -n "${DSH_PUBLIC_URL:-}" ]; then
  set -- "$@" --public-url "$DSH_PUBLIC_URL"
  for authority in ${DSH_TRUSTED_HOSTS:-}; do
    set -- "$@" --trusted-host "$authority"
  done
fi

exec dsh "$@"
