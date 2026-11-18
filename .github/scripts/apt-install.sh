#!/usr/bin/env bash
# Installs Ubuntu packages for a CI job: apt-get update and install, each with a time limit, retried up to three
# times. A stalled mirror or a package lock held by the runner's own updates once used up a job's whole time limit
# with no output; now an attempt ends after a few minutes and the next one starts.
#
# With APT_ARCHIVES set, downloaded packages are kept in that folder, which the job caches between runs: QGIS is about
# 200 MB of packages, which a slow mirror (about 180 kB/s at times) cannot deliver within the job's time. Finished
# downloads stay in the folder, so a retry continues where the last attempt stopped.
#   APT_ARCHIVES="$RUNNER_TEMP/apt-archives" .github/scripts/apt-install.sh python3-qgis qgis-providers
set -u
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o DPkg::Lock::Timeout=120)
if [ -n "${APT_ARCHIVES:-}" ]; then
  mkdir -p "$APT_ARCHIVES/partial"
  opts+=(-o "Dir::Cache::Archives=$APT_ARCHIVES" -o APT::Keep-Downloaded-Packages=true)
fi
status=1
for attempt in 1 2 3; do
  if sudo timeout 180 apt-get "${opts[@]}" update -q &&
     sudo DEBIAN_FRONTEND=noninteractive timeout 600 apt-get "${opts[@]}" install -y -q --no-install-recommends "$@"; then
    status=0
    break
  fi
  echo "apt-get attempt $attempt failed or timed out" >&2
  sleep 10
done
if [ -n "${APT_ARCHIVES:-}" ]; then
  # The cache action runs as the runner's user; apt wrote these files as root.
  sudo rm -rf "$APT_ARCHIVES/partial" "$APT_ARCHIVES/lock"
  sudo chown -R "$(id -u):$(id -g)" "$APT_ARCHIVES"
fi
exit $status
