#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${HOPWATCH_TEST_IMAGE:-hopwatch-test:local}"

cd "${REPO_ROOT}"

# Dockerfile.test COPYs the repo into /app and installs node_modules there.
# We used to bind-mount the repo over /workspace, but that hid /app and left
# the working tree without node_modules - `bun run check` then failed before
# exercising any code. Run against the image's /app WORKDIR so deps resolve.
# Rebuild is fast because only changed source invalidates cache layers after
# the install layer.
docker build -f Dockerfile.test -t "${IMAGE}" .
docker run --rm "${IMAGE}" bun run check
