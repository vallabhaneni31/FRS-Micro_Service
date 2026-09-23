# Rate Limit & DDoS Response Runbook — FRS Platform
**FRS-RB-007 | v1.0 | 2026-05-24**

## Rate Limit Configuration
| Limiter | Limit | Window | Store |
|---------|-------|--------|-------|
| Global API | 200 req | 1 min | Redis |
| Auth endpoints | 10 req | 15 min | Redis |
| Enrollment invite | 5 req | 1 hour | Redis |
| Photo download | 60 req | 1 min | Redis |

## Detecting an Attack
```bash
# Top IPs by request count (last 5 min)
grep '"path":"/api' /var/log/frs/app.log | \
  jq -r '.ip' | sort | uniq -c | sort -rn | head -20

# Check 429 rate in audit_log
psql $DATABASE_URL -c "
  SELECT ip_address, COUNT(*) AS hits
  FROM audit_log
  WHERE action = 'security.rate_limited'
    AND created_at > NOW() - '5 minutes'::interval
  GROUP BY ip_address ORDER BY hits DESC LIMIT 20;"

# Redis: check if global limiter is in memory fallback mode
redis-cli KEYS 'frs:rl:*' | wc -l
```

## Emergency Response
```bash
# Block a specific IP at load balancer (AWS WAF)
aws wafv2 update-ip-set \
  --scope CLOUDFRONT \
  --name frs-blocked-ips \
  --id $WAF_IP_SET_ID \
  --addresses "1.2.3.4/32" \
  --lock-token $(aws wafv2 get-ip-set --scope CLOUDFRONT --name frs-blocked-ips --id $WAF_IP_SET_ID --query LockToken --output text)

# Temporarily lower global rate limit (edit env + restart)
kubectl set env deployment/frs-backend RATE_LIMIT_MAX=50

# Clear Redis rate limit counters for a legitimate IP
redis-cli DEL "frs:rl:global:${IP_ADDRESS}"
```

## Post-Attack Review
- [ ] Identify source (bot, competitor, misconfigured client)
- [ ] Review WAF logs for patterns
- [ ] Consider Cloudflare / Shield Advanced if recurring
- [ ] File ticket to implement CAPTCHA on auth endpoints if bot attack
