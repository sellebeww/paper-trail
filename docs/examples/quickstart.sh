#!/usr/bin/env bash
# Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
#
# Register -> create a ledger -> add a note and a file -> read the head -> read the entries back.
# Needs only curl, awk and sed. Usage:  BASE=http://localhost:3000 ./docs/examples/quickstart.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
EMAIL="${EMAIL:-demo-$(date +%s)@example.test}"
PASSWORD="${PASSWORD:-kata-sandi-panjang-1}"
JAR="$(mktemp)"
trap 'rm -f "$JAR" "${SAMPLE:-}"' EXIT

# Cookie jar helpers. pt_csrf is the CSRF cookie; every POST must echo it in X-CSRF-Token.
csrf() { awk '$6 == "pt_csrf" { print $7 }' "$JAR"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }
post_json() { # path json
  curl -sS -b "$JAR" -c "$JAR" -H "Content-Type: application/json" -H "X-CSRF-Token: $(csrf)" \
    -X POST "$BASE$1" -d "$2"
}

echo "1) CSRF token for the pre-login request"
curl -sS -b "$JAR" -c "$JAR" "$BASE/auth/csrf" >/dev/null

echo "2) Register ($EMAIL)"
post_json /auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
echo

echo "3) Log in (registration already logged us in; this shows the login call)"
post_json /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
curl -sS -b "$JAR" "$BASE/auth/me"
echo

echo "4) Create a ledger"
LEDGER_JSON="$(post_json /ledgers '{"title":"Sengketa lembur Oktober","category":"kerja"}')"
echo "$LEDGER_JSON"
LEDGER_ID="$(echo "$LEDGER_JSON" | field id)"

echo "5) Add a note (the response holds the full entry and the new head: keep a copy)"
post_json "/ledgers/$LEDGER_ID/entries" '{"type":"note","text":"Atasan menolak membayar lembur."}'
echo

echo "6) Add a file (multipart; the type field must come before the file)"
SAMPLE="$(mktemp)"
printf '%%PDF-1.4\n%% contoh berkas\n' >"$SAMPLE"
curl -sS -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $(csrf)" \
  -F "type=file" -F "file=@$SAMPLE;filename=slip-gaji.pdf" \
  "$BASE/ledgers/$LEDGER_ID/entries/upload"
echo

echo "7) Read the head (store seq + hash as your 'last proof I saw')"
curl -sS -b "$JAR" "$BASE/ledgers/$LEDGER_ID/head"
echo

echo "8) Read the entries (cursor paging: add ?cursor=<next_cursor>&limit=50)"
curl -sS -b "$JAR" "$BASE/ledgers/$LEDGER_ID/entries"
echo

echo "9) Log out"
curl -sS -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $(csrf)" -X POST "$BASE/auth/logout" -o /dev/null -w "HTTP %{http_code}\n"
