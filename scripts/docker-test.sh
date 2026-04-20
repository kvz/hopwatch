#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${HOPWATCH_TEST_IMAGE:-hopwatch-test:local}"

cd "${REPO_ROOT}"

docker build -f Dockerfile.test -t "${IMAGE}" .
docker run --rm -v "${REPO_ROOT}":/workspace -w /workspace "${IMAGE}" bun run check
