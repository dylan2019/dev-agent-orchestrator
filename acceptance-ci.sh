#!/usr/bin/env bash
set -euo pipefail

npm run format:check
npm run lint
npm run check
npm test
npm audit --audit-level=high

