#!/bin/sh
set -e

./node_modules/.bin/prisma db push --skip-generate --schema packages/db/prisma/schema.prisma

exec "$@"
