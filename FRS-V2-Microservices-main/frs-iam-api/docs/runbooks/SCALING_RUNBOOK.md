# Scaling Runbook — FRS Platform
**FRS-RB-010 | v1.0 | 2026-05-24**

## Scaling Triggers
| Metric | Threshold | Action |
|--------|-----------|--------|
| CPU > 80% for 5 min | Warning | Scale out backend pods |
| p95 latency > 1s | Warning | Scale out + check DB connections |
| DB connections > 80% of max | Critical | Scale out read replicas |
| Redis memory > 80% | Warning | Increase Redis instance size |
| Error rate > 2% | Critical | Incident response + scale out |

## Horizontal Scale Out (Kubernetes)
```bash
# Scale backend deployment
kubectl scale deployment frs-backend --replicas=5

# Verify pods are healthy
kubectl rollout status deployment/frs-backend
kubectl get pods -l app=frs-backend

# Check DB connection pool (max = replicas × pool.max)
# Default pool.max = 10 → 5 replicas = 50 connections max
psql $DATABASE_URL -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = 'frs';"
```

## Database Connection Pool Tuning
```bash
# Increase pool size (requires restart)
kubectl set env deployment/frs-backend DB_POOL_MAX=20

# If connections are exhausted, use PgBouncer
# PgBouncer config: pool_mode=transaction, max_client_conn=500
```

## Redis Cluster Scaling
```bash
# Check Redis memory usage
redis-cli INFO memory | grep used_memory_human

# Flush expired rate limit keys (safe — only TTL'd keys)
redis-cli --scan --pattern 'frs:rl:*' | \
  xargs -L 100 redis-cli TTL | grep -c "^-1"  # count keys without TTL (should be 0)
```

## Jetson Device Load Distribution
```bash
# Check which Jetson has the most active faces
psql $DATABASE_URL -c "
  SELECT fd.external_device_id, COUNT(fe.pk_embedding_id) AS face_count
  FROM facility_device fd
  LEFT JOIN face_embedding fe ON fe.fk_employee_id IN (
    SELECT pk_employee_id FROM hr_employee WHERE tenant_id = fd.tenant_id
  )
  GROUP BY fd.external_device_id ORDER BY face_count DESC;"
```
