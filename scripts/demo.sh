#!/bin/sh
# Seed a running server with two demo users sharing a workspace.
#   scripts/demo.sh http://localhost:8080
set -eu
BASE=${1:-http://localhost:8080}
jar_a=$(mktemp); jar_b=$(mktemp)
post() { curl -sf -b "$1" -c "$1" -H "Origin: $BASE" -H 'Content-Type: application/json' -X "$2" "$BASE$3" -d "$4"; }
post "$jar_a" POST /api/auth/register '{"email":"ada@demo.test","password":"demo password 1","name":"Ada"}' >/dev/null || post "$jar_a" POST /api/auth/login '{"email":"ada@demo.test","password":"demo password 1"}' >/dev/null
post "$jar_b" POST /api/auth/register '{"email":"linus@demo.test","password":"demo password 2","name":"Linus"}' >/dev/null || true
wid=$(post "$jar_a" POST /api/workspaces '{"name":"Demo project"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
post "$jar_a" POST "/api/workspaces/$wid/members" '{"email":"linus@demo.test","role":"EDITOR"}' >/dev/null
for p in README.md src/main.ts src/util/math.ts; do post "$jar_a" POST "/api/workspaces/$wid/documents" "{\"path\":\"$p\"}" >/dev/null; done
echo "Open $BASE in two browsers: ada@demo.test / 'demo password 1' and linus@demo.test / 'demo password 2'"
rm -f "$jar_a" "$jar_b"
