#!/bin/bash

# FRS2 API Test Suite
# Tests all Phase 2-5 APIs to verify system functionality

BASE_URL="${FRS_TEST_BASE_URL:-http://localhost:8080}"
KEYCLOAK_URL="${FRS_TEST_KEYCLOAK_URL:-http://localhost:9090}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
TESTS_PASSED=0
TESTS_FAILED=0

# Test result function
test_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: $2"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}: $2"
        ((TESTS_FAILED++))
    fi
}

echo "========================================="
echo "FRS2 API Test Suite"
echo "========================================="
echo ""

# 1. Get Keycloak Token
echo "1. Authentication"
echo "-----------------"
TOKEN=$(curl -s -X POST \
  "$KEYCLOAK_URL/realms/attendance/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=attendance-frontend&username=admin@company.com&password=admin123&grant_type=password" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

if [ -n "$TOKEN" ]; then
    test_result 0 "Keycloak authentication"
else
    test_result 1 "Keycloak authentication"
    echo "Cannot proceed without authentication token"
    exit 1
fi
echo ""

# 2. Device Management APIs
echo "2. Device Management APIs"
echo "-------------------------"

# 2.1 List devices
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/device-management/devices")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /device-management/devices" || test_result 1 "GET /device-management/devices (HTTP $HTTP_CODE)"

# 2.2 Get device details
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/device-management/devices/jetson-orin-01")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /device-management/devices/:code" || test_result 1 "GET /device-management/devices/:code (HTTP $HTTP_CODE)"

echo ""

# 3. Site Management APIs
echo "3. Site Management APIs"
echo "-----------------------"

# 3.1 List sites
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/site-management/sites")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /site-management/sites" || test_result 1 "GET /site-management/sites (HTTP $HTTP_CODE)"

# 3.2 Get site details
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/site-management/sites/4")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /site-management/sites/:id" || test_result 1 "GET /site-management/sites/:id (HTTP $HTTP_CODE)"

echo ""

# 4. Device Assignment APIs
echo "4. Device Assignment APIs"
echo "-------------------------"

# 4.1 List site devices
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/device-management/sites/4/devices")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /device-management/sites/:id/devices" || test_result 1 "GET /device-management/sites/:id/devices (HTTP $HTTP_CODE)"

echo ""

# 5. Monitoring APIs
echo "5. Monitoring APIs"
echo "------------------"

# 5.1 Device status
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/monitoring/devices/status")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /monitoring/devices/status" || test_result 1 "GET /monitoring/devices/status (HTTP $HTTP_CODE)"

# 5.2 Alerts
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/monitoring/alerts")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /monitoring/alerts" || test_result 1 "GET /monitoring/alerts (HTTP $HTTP_CODE)"

echo ""

echo ""

# 7. Configuration APIs
echo "7. Configuration APIs"
echo "---------------------"

# 7.1 Get effective config
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/device-management/config/effective/jetson-orin-01")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /device-management/config/effective/:code" || test_result 1 "GET /device-management/config/effective/:code (HTTP $HTTP_CODE)"

echo ""

# 8. Employee APIs
echo "8. Employee APIs"
echo "----------------"

# 8.1 List employees
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/employees")
[ "$HTTP_CODE" = "200" ] && test_result 0 "GET /employees" || test_result 1 "GET /employees (HTTP $HTTP_CODE)"

echo ""

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo "Total: $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ ALL TESTS PASSED!${NC}"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    exit 1
fi
