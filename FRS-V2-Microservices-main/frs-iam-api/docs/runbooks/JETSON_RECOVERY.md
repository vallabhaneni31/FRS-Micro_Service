# Jetson NVR Device Recovery Runbook — FRS Platform
**FRS-RB-004 | v1.0 | 2026-05-24**

## When to Use
- Jetson device offline for > 15 minutes (heartbeat timeout)
- Face recognition failures at a site
- Device firmware update required
- SQLite face cache corruption

## Diagnose Device Status
```bash
# Check last heartbeat in DB
psql $DATABASE_URL -c "
  SELECT external_device_id, status, last_heartbeat,
         NOW() - last_heartbeat AS offline_duration
  FROM facility_device
  WHERE NOW() - last_heartbeat > '15 minutes'::interval
  ORDER BY offline_duration DESC;
"

# Ping device directly (from VPN)
curl -s http://${JETSON_IP}:5000/health | jq .

# Check device logs via SSH (if accessible)
ssh jetson@${JETSON_IP} journalctl -u frs-jetson -n 100
```

## Recovery Procedures

### Case 1: Network Issue
```bash
# Check connectivity from cloud NAT
nc -zv ${JETSON_IP} 5000

# Verify device firewall rules allow cloud IPs
ssh jetson@${JETSON_IP} sudo iptables -L INPUT -n | grep 5000
```

### Case 2: SQLite Cache Corruption
```bash
# Trigger full resync from cloud API
curl -X POST https://api.frs.example.com/api/face/sync/all \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "x-device-id: $DEVICE_CODE"

# Or via GDPR erasure (purges and re-syncs one employee)
curl -X DELETE https://api.frs.example.com/api/employees/$EMPLOYEE_ID/biometric-data \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Case 3: Rotate Device JWT Token
```bash
# Rotate via API (revokes old token, issues new one)
curl -X POST https://api.frs.example.com/api/device-tokens/${DEVICE_ID}/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# The new token must be pushed to the device via Kafka or manual update
```

### Case 4: Full Device Reset
```bash
ssh jetson@${JETSON_IP}
sudo systemctl stop frs-jetson
rm -f /var/frs/faces.db   # clear SQLite cache
sudo systemctl start frs-jetson
# Device will re-sync embeddings on next poll
```
