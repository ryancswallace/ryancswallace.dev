#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

export ASTRO_TELEMETRY_DISABLED=1
pnpm_store_dir="${PNPM_STORE_DIR:-$repo_root/.pnpm-store}"
mkdir -p "$pnpm_store_dir"

pnpm install --frozen-lockfile --prefer-offline --store-dir "$pnpm_store_dir"
pnpm run sync

pnpm exec prettier --version >/dev/null
pnpm exec eslint --version >/dev/null
pnpm exec tsc --version >/dev/null
pnpm exec astro --version >/dev/null
