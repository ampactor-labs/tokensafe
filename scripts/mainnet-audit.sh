#!/usr/bin/env bash
set -euo pipefail

BASE="https://tokensafe-production.up.railway.app"
WSOL="So11111111111111111111111111111111111111112"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
BEARER='L729o+mYWbj/qL9ou19/r37fwDhA2c30VtS7VJNRA90='

PASS=0
FAIL=0

ok() { echo "   ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "   ✗ $1"; FAIL=$((FAIL+1)); }

cfetch() { curl --compressed --max-time 15 -s "$@"; }

echo "========================================"
echo "  TOKENSAFE FULL MAINNET AUDIT"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"

echo ""
echo "=== FREE ENDPOINTS ==="
echo ""

# 1. Health
echo "1. GET /health"
R=$(cfetch "$BASE/health")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'status={d[\"status\"]} v={d[\"version\"]} net={d[\"network\"]} up={d[\"uptime\"]}s')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 2. Discovery
echo "2. GET /.well-known/x402"
R=$(cfetch "$BASE/.well-known/x402")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'version={d[\"version\"]} resources={len(d[\"resources\"])}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 3. Lite wSOL
echo "3. GET /v1/check/lite (wSOL)"
R=$(cfetch "$BASE/v1/check/lite?mint=$WSOL")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'risk={d[\"risk_score\"]} ({d[\"risk_level\"]}) sell={d[\"can_sell\"]} liq={d[\"has_liquidity\"]} name={d.get(\"name\")}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

sleep 2

# 4. Lite USDC
echo "4. GET /v1/check/lite (USDC)"
R=$(cfetch "$BASE/v1/check/lite?mint=$USDC_MINT")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'risk={d[\"risk_score\"]} ({d[\"risk_level\"]}) sell={d[\"can_sell\"]} liq={d[\"has_liquidity\"]} name={d.get(\"name\")}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

sleep 2

# 5. Lite USDT
echo "5. GET /v1/check/lite (USDT)"
R=$(cfetch "$BASE/v1/check/lite?mint=$USDT_MINT")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'risk={d[\"risk_score\"]} ({d[\"risk_level\"]}) sell={d[\"can_sell\"]} liq={d[\"has_liquidity\"]} name={d.get(\"name\")}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

sleep 2

# 6. Decide default threshold
echo "6. GET /v1/decide (wSOL, threshold=30)"
R=$(cfetch "$BASE/v1/decide?mint=$WSOL&threshold=30")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'decision={d[\"decision\"]} risk={d[\"risk_score\"]} threshold={d[\"threshold_used\"]}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

sleep 2

# 7. Decide threshold=0
echo "7. GET /v1/decide (wSOL, threshold=0)"
R=$(cfetch "$BASE/v1/decide?mint=$WSOL&threshold=0")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'decision={d[\"decision\"]} risk={d[\"risk_score\"]} threshold={d[\"threshold_used\"]}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 8. MCP tools/list
echo "8. POST /mcp (tools/list)"
R=$(cfetch -X POST "$BASE/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
echo "$R" | grep -q "solana_token_safety_check" && ok "tool: solana_token_safety_check" || fail "tool not found: $(echo "$R" | head -c 200)"

# 9. MCP tools/call
echo "9. POST /mcp (tools/call wSOL)"
R=$(cfetch -X POST "$BASE/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"solana_token_safety_check\",\"arguments\":{\"mint_address\":\"$WSOL\"}}}")
echo "$R" | grep -q "risk_score" && ok "returned risk_score" || fail "$(echo "$R" | head -c 200)"

# 10. x402 gate
echo "10. GET /v1/check (expect 402)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" "$BASE/v1/check?mint=$WSOL")
[ "$HTTP" = "402" ] && ok "HTTP 402" || fail "HTTP $HTTP"

# 11. Batch gate
echo "11. POST /v1/check/batch/small (expect 402)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/check/batch/small" -H "Content-Type: application/json" -d "{\"mints\":[\"$WSOL\"]}")
[ "$HTTP" = "402" ] && ok "HTTP 402" || fail "HTTP $HTTP"

# 12. Error: bad mint
echo "12. GET /v1/check/lite (bad mint → 400)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" "$BASE/v1/check/lite?mint=notavalidmint")
[ "$HTTP" = "400" ] && ok "HTTP 400 INVALID_MINT_ADDRESS" || fail "HTTP $HTTP"

# 13. Error: missing mint
echo "13. GET /v1/check/lite (no mint → 400)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" "$BASE/v1/check/lite")
[ "$HTTP" = "400" ] && ok "HTTP 400 MISSING_REQUIRED_PARAM" || fail "HTTP $HTTP"

# 14. Error: unknown route
echo "14. GET /v1/nonexistent (→ 404)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" "$BASE/v1/nonexistent")
[ "$HTTP" = "404" ] && ok "HTTP 404 NOT_FOUND" || fail "HTTP $HTTP"

echo ""
echo "=== BEARER-PROTECTED ENDPOINTS ==="
echo ""

# 15. Metrics with bearer
echo "15. GET /metrics (with bearer)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $BEARER" "$BASE/metrics")
if [ "$HTTP" = "200" ]; then
  LINES=$(cfetch -H "Authorization: Bearer $BEARER" "$BASE/metrics" | wc -l)
  ok "HTTP 200 ($LINES lines of Prometheus metrics)"
else
  fail "HTTP $HTTP"
fi

# 16. Metrics without bearer
echo "16. GET /metrics (no bearer → 401)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" "$BASE/metrics")
[ "$HTTP" = "401" ] && ok "HTTP 401" || fail "HTTP $HTTP"

# 17. Create API key
echo "17. POST /v1/api-keys (create pro key)"
R=$(cfetch -X POST "$BASE/v1/api-keys" -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" -d '{"label":"audit-test-key","tier":"pro"}')
API_KEY=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('key',''))" 2>/dev/null)
API_KEY_ID=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('id',''))" 2>/dev/null)
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'id={d[\"id\"]} prefix={d[\"key_prefix\"]} tier={d[\"tier\"]}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 18. List API keys
echo "18. GET /v1/api-keys (list)"
R=$(cfetch -H "Authorization: Bearer $BEARER" "$BASE/v1/api-keys")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'{len(d)} key(s)')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 19. API key usage
echo "19. GET /v1/api-keys/$API_KEY_ID/usage"
R=$(cfetch -H "Authorization: Bearer $BEARER" "$BASE/v1/api-keys/$API_KEY_ID/usage")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'checks={d.get(\"current_month\",{}).get(\"check_count\",0)}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 20. Use API key to bypass x402
echo "20. GET /v1/check (with API key, bypass x402)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" -H "X-API-Key: $API_KEY" "$BASE/v1/check?mint=$WSOL")
if [ "$HTTP" = "200" ]; then
  R=$(cfetch -H "X-API-Key: $API_KEY" "$BASE/v1/check?mint=$WSOL")
  V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'risk={d[\"risk_score\"]} ({d[\"risk_level\"]})')" 2>/dev/null) && ok "x402 bypassed — $V" || ok "HTTP 200 (bypass worked)"
else
  fail "HTTP $HTTP (expected 200 with API key)"
fi

# 21. Create webhook
echo "21. POST /v1/webhooks (create)"
R=$(cfetch -X POST "$BASE/v1/webhooks" -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" -d "{\"callback_url\":\"https://httpbin.org/post\",\"mints\":[\"$WSOL\"],\"threshold\":50}")
WH_ID=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('id',''))" 2>/dev/null)
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'id={d[\"id\"]} threshold={d[\"threshold\"]}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 22. List webhooks
echo "22. GET /v1/webhooks (list)"
R=$(cfetch -H "Authorization: Bearer $BEARER" "$BASE/v1/webhooks")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'{len(d)} webhook(s)')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 23. Update webhook
echo "23. PATCH /v1/webhooks/$WH_ID (update)"
R=$(cfetch -X PATCH "$BASE/v1/webhooks/$WH_ID" -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" -d '{"threshold":25}')
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'threshold → {d[\"threshold\"]}')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# 24. Delete webhook
echo "24. DELETE /v1/webhooks/$WH_ID"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" -X DELETE "$BASE/v1/webhooks/$WH_ID" -H "Authorization: Bearer $BEARER")
[ "$HTTP" = "204" ] && ok "HTTP 204" || fail "HTTP $HTTP"

# 25. Audit history (empty)
echo "25. GET /v1/audit/history"
R=$(cfetch -H "Authorization: Bearer $BEARER" "$BASE/v1/audit/history")
V=$(echo "$R" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'{len(d)} audit(s)')" 2>/dev/null) && ok "$V" || fail "$(echo "$R" | head -c 200)"

# Cleanup: delete API key
echo "26. DELETE /v1/api-keys/$API_KEY_ID (cleanup)"
HTTP=$(cfetch -o /dev/null -w "%{http_code}" -X DELETE "$BASE/v1/api-keys/$API_KEY_ID" -H "Authorization: Bearer $BEARER")
[ "$HTTP" = "204" ] && ok "HTTP 204" || fail "HTTP $HTTP"

echo ""
echo "=== SUMMARY ==="
TOTAL=$((PASS+FAIL))
echo "   $PASS passed, $FAIL failed ($TOTAL total)"
echo ""
echo "=== x402 PAID ENDPOINTS ==="
echo "   (run separately — requires SVM_PRIVATE_KEY + real USDC)"
echo ""
exit $FAIL
