#!/usr/bin/env bash
# Installs Ubuntu packages for a CI job: apt-get update and install, each with a time limit, retried up to three
# times. A stalled mirror or a package lock held by the runner's own updates once used up a job's whole time limit
# with no output; now an attempt ends after a few minutes and the next one starts.
#   .github/scripts/apt-install.sh python3-qgis qgis-providers
set -u
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o DPkg::Lock::Timeout=120)
for attempt in 1 2 3; do
  if sudo timeout 180 apt-get "${opts[@]}" update -q &&
     sudo DEBIAN_FRONTEND=noninteractive timeout 600 apt-get "${opts[@]}" install -y -qq --no-install-recommends "$@"; then
    exit 0
  fi
  echo "apt-get attempt $attempt failed or timed out" >&2
  sleep 10
done
exit 1
