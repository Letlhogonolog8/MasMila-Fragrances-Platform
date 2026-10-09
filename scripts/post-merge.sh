#!/bin/bash
# Runs after a merge in the Replit workspace. Installs dependencies only: it
# never changes a database schema. Development databases are updated by hand
# (`pnpm --filter @workspace/db run push`); deployed ones only with the
# reviewed migrations (docs/DATABASE_MIGRATIONS.md).
set -e
pnpm install --frozen-lockfile
