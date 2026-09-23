# Architecture Shard: _core (Shared Estate Contracts)

> Applies to: Cross-service contracts, common database entities, shared sidecars

## 1. Database & Persistence Contracts
All backend services share or coordinate over PostgreSQL databases. The primary logical entities include:
- `users`, `roles`, `permissions`, `user_roles`: Managed and mutated exclusively by `frs-core-api`. Read by `frs-fe-api` for site/user correlations.
- `employees`, `visitors`, `employee_embeddings`: Written by `frs-fe-api` (UI enrollment) and `frs-edge-api` (direct edge box vector enrollment).
- `attendance_logs`, `events`: Produced by `frs-edge-api` (recognition events from Jetson/cameras) and queried/updated by `frs-fe-api` (attendance reporting and manual overrides).
- `cameras`, `devices`, `sites`: Configured via `frs-fe-api` (UI) and polled/ingested by `frs-edge-api`.

## 2. Authentication & Authorization Contract
- **Identity Provider:** Keycloak.
- **Tokens:** RS256/HS256 signed JSON Web Tokens (JWT) issued on login.
- **Verification:** Services independently verify incoming Bearer tokens using Keycloak's JWKS endpoint or public certificate without cross-calling `frs-core-api` on every request.
- **Device Tokens:** Edge devices authenticate to `frs-edge-api` using pre-shared API keys and HMAC headers (`X-Device-Id`, `X-Device-Token`).

## 3. Sidecars & Auxiliary Services
### face-quality Service (Port 5050)
- **Engine:** Python 3, Flask, Mediapipe Face Mesh, ONNX ArcFace validator.
- **Endpoint:** `POST http://localhost:5050/score`
- **Request:** Multipart form with `image` file or base64 data.
- **Response:** JSON `{ "score": 0.88, "passed": true, "landmarks": {...}, "quality": "HIGH" }`
- **Clients:** `frs-fe-api` (UI photo check) and `frs-edge-api` (fallback frame check).
