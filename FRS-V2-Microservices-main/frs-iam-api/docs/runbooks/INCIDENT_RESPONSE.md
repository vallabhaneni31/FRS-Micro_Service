# Incident Response Runbook — FRS Platform
**FRS-RB-002 | v1.0 | 2026-05-24**

## Severity Levels
| Level | Definition | Response Time | Examples |
|-------|-----------|--------------|---------|
| P1 Critical | Full service outage or data breach | 15 min | DB down, auth service unreachable, biometric data leak |
| P2 High | Partial outage or security incident | 1 hour | Single tenant down, rate limit bypass detected |
| P3 Medium | Degraded performance | 4 hours | p95 latency > 2s, elevated error rate |
| P4 Low | Minor issue | Next business day | Non-critical log errors, cosmetic bugs |

## P1 Response Steps
1. **Page on-call** — PagerDuty auto-pages; acknowledge within 5 min
2. **Create war room** — Slack #incidents channel + video call
3. **Assess scope** — how many tenants / users affected?
4. **Containment** — isolate affected component (block IPs, disable endpoints)
5. **Communicate** — status page update within 15 min
6. **Remediate** — fix, deploy, verify
7. **Post-mortem** — within 48h of resolution

## Security Incident Response (Data Breach)
1. Immediately alert CISO + Legal
2. Preserve logs — do NOT modify or delete
3. Isolate affected tenant data
4. Assess GDPR 72-hour notification obligation (Art. 33)
5. Contact DPA if personal data is confirmed breached
6. Coordinate with cloud provider for forensic image
7. Notify affected data subjects per Art. 34 if high risk

## Key Commands
```bash
# Check service health
curl https://api.frs.example.com/api/health

# View last 100 errors
grep '"level":"error"' /var/log/frs/app.log | tail -100

# Check DB connections
psql $DATABASE_URL -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Emergency rate limit tighten
redis-cli SET frs:rl:emergency_mode 1 EX 3600
```

## Post-Mortem Template
- **Incident title:** 
- **Date/time:** 
- **Duration:**
- **Impact:**
- **Root cause:**
- **Timeline:**
- **Action items:**
