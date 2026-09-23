# Data Protection Impact Assessment (DPIA)
## Facial Recognition System (FRS) — Enterprise SaaS Platform

**Document Reference:** FRS-DPIA-001  
**Version:** 1.0  
**Date:** 2026-05-24  
**Classification:** CONFIDENTIAL  
**Owner:** Data Protection Officer / Engineering Lead  
**Prepared by:** Security Engineering Team  
**Review Cycle:** Annual or upon material system change

---

## 1. Purpose and Legal Basis

This DPIA is conducted pursuant to **GDPR Article 35** which requires a DPIA before processing that is "likely to result in a high risk to the rights and freedoms of natural persons." Facial recognition using biometric data (GDPR Art.9 special category) requires mandatory DPIA.

**Legal basis for processing:**
- **Art.6(1)(b)** — Processing necessary for the performance of a contract (employment agreement)
- **Art.6(1)(c)** — Legal obligation (workplace safety / access control regulations)
- **Art.9(2)(a)** — Explicit consent from the data subject (biometric_consent table, FIX-025)

---

## 2. System Description

### 2.1 Processing Activity
**Name:** Employee Facial Recognition for Attendance and Access Control  
**Controller:** Each tenant organisation (multi-tenant SaaS model)  
**Processor:** FRS Platform Operator (Motivity Labs)  
**Sub-processors:** AWS (infrastructure), Keycloak (identity), optional: Kafka (event streaming)

### 2.2 Data Flows

```
Employee → Enrollment Portal → Cloud API → PostgreSQL (encrypted embeddings)
                                        ↓
                               Jetson NVR Edge Device (SQLite cache, purged on erasure)
                                        ↓
                               Attendance Record (tenant-scoped, 2yr retention)
```

### 2.3 Data Categories Processed

| Category | Data Elements | Special Category? | Retention |
|----------|--------------|-------------------|-----------|
| Identity | Name, employee code, email | No | Employment duration |
| Biometric | Face embedding vector (512-d float32) | **Yes — Art.9** | 3yr post-inactivation |
| Biometric | Enrollment photos (5 angles) | **Yes — Art.9** | Purged after embedding (24h delay) |
| Attendance | Timestamp, location, photo snapshot | No | 2 years |
| Audit | Action logs, IP address, user agent | No | 1 year |

---

## 3. Necessity and Proportionality

### 3.1 Purpose Limitation
- Embeddings are used **only** for attendance marking and access control
- No secondary use (marketing, profiling, law enforcement sharing) is permitted
- System architecture enforces tenant isolation (RLS, scope extraction)

### 3.2 Data Minimisation
- **Embedding-only storage:** Raw photos are purged within 24h of embedding creation (FIX-022, photoPurgeCron)
- **Minimal embedding size:** 512-dimensional ArcFace vectors — sufficient for identification, not excessive
- **Attendance snapshots:** Low-resolution reference photos only, retained 2yr

### 3.3 Accuracy
- Threshold-based matching (configurable, default 60% similarity)
- Duplicate detection prevents re-enrollment under different identities (FIX-023)
- AI bias testing tracked in bias_evaluation table (FIX-036)

---

## 4. Risk Assessment

### 4.1 Risk Matrix

| Risk | Likelihood | Severity | Inherent Risk | Controls | Residual Risk |
|------|-----------|---------|--------------|---------|--------------|
| Unauthorised access to biometric DB | Medium | Critical | **HIGH** | AES-256-GCM encryption (FIX-021), RLS (FIX-013), JWT auth | **MEDIUM** |
| Embedding exfiltration via API | Medium | High | **HIGH** | requirePermission('attendance.read'), rate limiting (FIX-009) | **LOW** |
| Face photo interception in transit | Low | High | **MEDIUM** | TLS enforced (FIX-002, FIX-018), HSTS | **LOW** |
| False positive identification | Medium | Medium | **MEDIUM** | Configurable threshold, manual review workflow | **MEDIUM** |
| Cross-tenant data leakage | Low | Critical | **HIGH** | Tenant RLS (FIX-013), scope validation (FIX-011) | **LOW** |
| Jetson device compromise | Medium | High | **HIGH** | Device JWT auth (FIX-012), TLS (FIX-018), revocation | **MEDIUM** |
| SSRF via Jetson URL | Low | High | **MEDIUM** | IP allowlist validation (FIX-003) | **LOW** |
| Audit trail tampering | Low | High | **MEDIUM** | Immutable triggers + hash chain (FIX-007) | **LOW** |
| Data retained beyond legal period | Medium | Medium | **MEDIUM** | Configurable retention cron (FIX-027) | **LOW** |
| Consent not obtained before collection | Medium | High | **HIGH** | biometric_consent table (FIX-025), API gate | **LOW** |

### 4.2 High-Residual-Risk Items

**MEDIUM residual risks** requiring ongoing attention:

1. **False positive identification** — could result in incorrect attendance records or denial of access
   - *Mitigation:* Human review workflow; configurable similarity threshold; AI bias evaluation (FIX-036)

2. **Jetson edge device compromise** — physical access to NVR could expose SQLite cache
   - *Mitigation:* Device JWT rotation (FIX-012), GDPR erasure propagation (FIX-026), disk encryption on Jetson

---

## 5. Data Subject Rights Implementation

| Right | Implementation | Response Time |
|-------|---------------|--------------|
| **Access (Art.15)** | `GET /api/employees/:id` returns all data | 30 days |
| **Rectification (Art.16)** | `PUT /api/employees/:id` | Immediate |
| **Erasure (Art.17)** | `DELETE /api/employees/:id/biometric-data` → gdprErasureService (FIX-026) | 72 hours |
| **Restriction (Art.18)** | Deactivate employee; embeddings retained but inactive | Immediate |
| **Portability (Art.20)** | Not applicable (biometric data not portable per WP29 guidance) | N/A |
| **Withdraw Consent (Art.7(3))** | `POST /api/consent/biometric/withdraw` → auto-triggers erasure | 24 hours |
| **Object (Art.21)** | HR process → admin deactivates employee | 30 days |

---

## 6. Security Measures (Technical and Organisational)

### Technical Controls
| Control | Implementation | Fix Reference |
|---------|---------------|---------------|
| Encryption at rest | AES-256-GCM per embedding row | FIX-021 |
| Encryption in transit | TLS 1.2+ enforced, HSTS | FIX-002, FIX-018 |
| Access control | JWT + RBAC + Scope isolation | FIX-004, FIX-011 |
| Database isolation | PostgreSQL RLS per tenant | FIX-013 |
| Photo minimisation | Auto-purge 24h post-embedding | FIX-022 |
| Audit logging | Immutable hash-chained audit_log | FIX-007 |
| Consent gate | biometric_consent required before upload | FIX-025 |
| Erasure propagation | Jetson cache cleared on GDPR erasure | FIX-026 |
| Secret management | Startup validation, no hardcoded secrets | FIX-001, FIX-010 |
| Rate limiting | Redis distributed rate limiter | FIX-009 |

### Organisational Controls
- Employee notice provided before enrollment (plain-language consent form)
- HR administrators trained on data subject rights procedures
- DPO designated and contactable
- Annual DPIA review cycle
- Penetration testing at least annually (FIX-044)
- DR drills at least annually (FIX-041)

---

## 7. Consultation

| Stakeholder | Consulted | Date | Notes |
|------------|----------|------|-------|
| Data Protection Officer | ☐ Pending | — | Required before go-live |
| Employee Works Council / Union | ☐ Pending | — | Required in DE/FR jurisdictions |
| Supervisory Authority | ☐ Not required | — | Required only if residual risk remains HIGH |
| Legal Counsel | ☐ Pending | — | Review Art.9 lawful basis per tenant jurisdiction |

---

## 8. Conclusion and Sign-off

**Assessment:** Processing activities are proportionate, legally grounded, and appropriately safeguarded when all FIX-021 to FIX-028 controls are in production.

**Outstanding actions before go-live:**
- [ ] DPO review and sign-off on this DPIA
- [ ] Penetration test (FIX-044)
- [ ] AI bias evaluation baseline (FIX-036)
- [ ] Employee-facing privacy notice published
- [ ] Supervisory authority prior consultation (if required by jurisdiction)

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Data Protection Officer | ___________ | ___________ | ___________ |
| Engineering Lead | ___________ | ___________ | ___________ |
| CISO | ___________ | ___________ | ___________ |

---

*This DPIA was generated as part of enterprise security remediation FIX-028. Review annually or upon material change to processing activities, data categories, or system architecture.*
