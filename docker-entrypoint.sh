#!/bin/sh
set -e

./packages/db/node_modules/.bin/prisma db push --skip-generate --schema packages/db/prisma/schema.prisma

exec "$@"
