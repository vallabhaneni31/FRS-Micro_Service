# S3 Image Storage Migration — Employee/Attendance/Visitor Photos
**FRS-RB-013 | v1.0 | 2026-07-23**

## When to Use
- Replicating this image-storage setup in a new environment (staging/prod), or standing up a fresh QA-style deployment.
- Onboarding an engineer to how/where photos are stored.
- Debugging a photo that 404s, or an upload that silently isn't landing in S3.

## How It Works
Two S3 buckets, one for permanent identity photos and one for time-stamped event photos:

```
{USER_DATA_BUCKET}/tenant-{tenantId}/users/{employeeCode}/
  ├── profile/profile.jpg
  └── enrollment/{front,left,right,up,down}.jpg

{LOGS_BUCKET}/tenant-{tenantId}/
  ├── employee/{employeeCode}/{YYYY-MM-DD}/{in,out}/{EmployeeName}_{YYYY-MM-DD}_{HH-MM-SS}-{nonce}.jpg
  └── visitor/{visitorId}/{YYYY-MM-DD}/{in,out}/Visitor_{visitorId}_{YYYY-MM-DD}_{HH-MM-SS}-{nonce}.jpg
```

Key principles:
- **Keys are always rooted at the tenant's stable UUID**, never its (renameable) display name — see `s3KeyBuilder.js`'s header comment. A prior incident (`jetson-09` device renamed to `jetson-09-paused`, breaking lookups keyed by the old name — see [[jetson-device-identity-mismatch]]) is the reason this rule exists; `PersonService`'s visitor-photo path used to violate it (keyed by tenant *name* via a `getTenantFolderName()` helper) and was fixed as part of this migration.
- **The `-{nonce}` suffix** on event-photo time components is a deliberate deviation from the literal naming spec: `event_time` only carries second precision on the wire, so two frames landing in the same second would otherwise silently overwrite each other in S3. Not a bug — don't remove it.
- **Enrollment/profile filenames are stable, not timestamped** (`front.jpg`, `profile.jpg`) — re-uploading an angle overwrites it in place rather than accumulating stale objects.
- `profile/profile.jpg` is derived automatically from the "front" angle whenever it's uploaded (HR Direct Enrollment's `enroll-face`/`enroll-remote`, or the Email-Based Self-Enrollment portal's `uploadAngle`) — there is no separate "upload a profile photo" feature.

## Shared code
- `src/services/storageService.js` — thin S3 wrapper: `uploadFile`, `deleteFile`, `getFileStream`, `getFileBuffer`, `getDownloadUrl` (presigned). Exports `LOGS_BUCKET`/`USER_DATA_BUCKET` resolved from env.
- `src/utils/s3KeyBuilder.js` — pure key/filename builders: `sanitizeForKey`, `eventDateTimeParts`, `buildUserDataKey` (profile/enrollment), `buildEventPhotoKey`/`buildEventPhotoFilename` (attendance/visitor events).
- `src/services/business/eventPhotoService.js` — identity/direction resolution + upload for event photos, shared by the device-event pipeline (`DeviceEventService`), the legacy recognition pipeline (`FaceController`), and (via the lower-tier key builders) visitor registration (`PersonService`).
- `src/services/photoResolverService.js` — resolves a bare filename to `{bucket,key}` (S3) or `{legacyLocalPath}` (pre-migration local disk / full URL) by matching across 7 tables/columns. `isLegacyLocalPath()` treats a leading `/` or a `http(s)://` URL as legacy.

## Env vars
Set in `backend/api/.env` (see `src/config/env.js` lines ~157-166):

| Var | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials. Omit both to fall back to the SDK's default provider chain (IAM instance role — preferred for EC2/ECS). |
| `AWS_REGION` | Defaults to `us-east-1` if unset. |
| `AWS_S3_LOGS_BUCKET` | e.g. `motivity-frs-logs-qa` |
| `AWS_S3_USER_DATA_BUCKET` | e.g. `motivity-frs-user-qa` |
| `AWS_S3_ENDPOINT` / `AWS_S3_FORCE_PATH_STYLE` | MinIO/local-dev only — leave unset against real AWS. |

**Known soft spot:** validation of these (`env.js` ~lines 249-255) is warn-only, not fail-fast — a missing bucket name logs a warning at boot but the server still starts, then throws at the first upload attempt (`storageService.uploadFile`: `Missing S3 bucket for key`). Worth hardening to fail fast in a future pass.

## IAM Policy (document and verify — do not apply blindly)
The credential already in use should carry (at minimum) this least-privilege policy, scoped to exactly the two buckets:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::motivity-frs-user-qa/*",
        "arn:aws:s3:::motivity-frs-logs-qa/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::motivity-frs-user-qa",
        "arn:aws:s3:::motivity-frs-logs-qa"
      ]
    }
  ]
}
```
For a new environment, swap the bucket names and attach this to the IAM user/role the backend runs as. **Do not apply this to an already-working credential without checking its current policy first** — tightening scope on a live credential can break production if the existing policy is relied on elsewhere.

## Deployment steps (new environment)
1. Create the two S3 buckets (private, no public access).
2. Create/identify an IAM user or role and attach the policy above (with that environment's bucket names).
3. Set the env vars in `backend/api/.env`.
4. Restart the backend (`pm2 reload frs-backend` or equivalent) — env vars are read at process start.
5. Run the verification steps below.

## Employee enrollment — two workflows, three backend routes
Both workflows are driven from `frontend/.../hr/FaceEnrollButton.tsx` and the invitation-based portal; all write to `USER_DATA_BUCKET`.

| Workflow | Route(s) | Notes |
|---|---|---|
| **HR Direct Enrollment** (HR uploads in-app) | `POST /api/employees/:id/enroll-face` | Primary path — needs direct Jetson sidecar reachability. Now uploads the photo (previously discarded entirely) and derives profile.jpg on the front angle. |
| | `POST /api/employees/:id/enroll-face-direct` | Device-authenticated (C++ runner posts a precomputed embedding). `photo_path` is now validated to start with `tenant-` before being trusted. |
| | `POST /api/employees/:id/enroll-remote` | Fallback when Jetson isn't directly reachable — queues an `enroll_from_photo` command. Fixed a `ReferenceError` (missing `sanitizeForKey` import) that crashed this route on every call. |
| **HR Email-Based Self Enrollment** (employee's own device via emailed link) | `POST /api/enroll/:token/upload-angle` → `EnrollmentService.uploadAngle` | Was already S3-backed; fixed filename convention (`front.jpg` not `image_front.jpg`) and added profile.jpg derivation. |

## Event timestamp staleness guard (added post-migration, 2026-07-23)
While verifying this migration live, found today's real check-in events landing in `attendance_record` and S3 under weeks-old dates instead of today — `attendance_date` and the event-photo date folder are both deliberately derived from the device-reported `event_time` (not arrival time), to correctly handle a device that's been offline and is now draining its queue. But a **jetson-09-paused** test device was sending `event_time` values that were consistently ~3-5 weeks stale despite delivering in real time, silently misfiling everything under old dates — so the dashboard/attendance page showed nothing for "today" even though events were arriving (visible instead as non-zero counts in any widget that queries by arrival time rather than `attendance_date`).

Fix: `DeviceEventService.processEvent()` now runs every incoming `event_time`/`timestamp` through `resolveEventTimestamp()` before anything else uses it — if it's more than 48h from "now" (either direction), it's treated as an unreliable device clock/queue-replay artifact and replaced with arrival time, with a warning logged (`device code`, `event type`, `reported event_time`, `drift in hours`). The original value is preserved as `payload.event_time_raw` on the stored `device_events` row for later device-side diagnosis. This single fix point covers both attendance-date computation (`handleFaceRecognized`) and S3 photo folder placement (`uploadEventPhoto`), since both read the same normalized `payload.event_time`.

**This does not fix the underlying device issue** — something on that Jetson (clock drift, or a queue replaying old buffered events with their original capture timestamps) is still sending bad timestamps; this guard only prevents that from silently corrupting attendance records and photo organization. Worth a follow-up investigation of the device itself (check `date` on the Jetson, check whether its offline-queue is replaying genuinely old entries it should have drained weeks ago).

**Follow-up finding, same day:** correcting the *date* wasn't enough — the *photo* attached to these events is equally unreliable. Traced it by downloading the actual S3 objects for several corrected events directly (bypassing the app): they're genuinely different images (different sizes/hashes), each with a distinct but old capture timestamp burned into the frame, arriving in rapid bursts (dozens of events within ~1 second of real time). That's not a caching or DB-mapping bug — it's the device (or a test harness driving it) replaying old recorded footage. So `handleFaceRecognized` now checks `payload.event_time_raw` (only set when `resolveEventTimestamp` had to correct the timestamp) and passes `null` instead of the real `photo_url` to `attendance_record.checkin_photo_url`/`checkout_photo_url` in that case — the real photo is still uploaded to S3 and kept in the raw `device_events.payload_json` for forensics, it's just not surfaced as attendance "proof" in the UI.

Caught one bug while building this: the initial version detected staleness by comparing `resolveEventTimestamp()`'s output string to the raw input string — but the output is always a normalized `.toISOString()` (with milliseconds), so any legitimately fresh timestamp missing milliseconds (or in another valid-but-different format) would look "changed" and get wrongly flagged as stale. Fixed by having `resolveEventTimestamp()` return `{ value, wasStale }` explicitly rather than making callers infer staleness from string equality. Also caught a second bug: the `attendance.checkin`/`checkout` case builds a fresh `canonicalPayload` object that didn't originally carry over `event_time_raw`, so the photo-suppression check silently never fired for that event type — fixed by including it in that object. Both are covered by regression tests in `s3Storage.test.js`.

**Follow-up finding: the attendance LIST endpoints leaked the photo through a second path.** Suppressing `attendance_record.checkin/checkout_photo_url` wasn't sufficient — the roster/history queries in `liveRepository.js` (×2), `AttendanceService.js`, and `hrRoutes.js` independently build a per-ping `all_check_ins`/`all_check_outs` array by reading `de.payload_json->>'photo_url'` straight off `device_events`, and the frontend falls back to that array whenever the summary column is empty. All 6 occurrences of that extraction now go through the same `event_time_raw`-based suppression. Events processed before `event_time_raw` existed had nothing to check, so a one-time backfill flagged historical rows whose S3 photo's date-folder didn't match their actual arrival date (51,312 rows). Lesson: when suppressing a field, grep for every other place that reads the same underlying raw column — don't assume one write path's fix covers all read paths.

## Known Gaps / Follow-ups (explicitly out of scope for this migration)
- **GDPR erasure coverage**: `gdprErasureService.js` only purges `enrollment_invitations.photo_paths` from S3 — not `employee_face_embeddings.photo_path`, `person.photo_url`, or `attendance_record.*_photo_url`. A "complete" erasure can leave orphaned S3 objects under those columns.
- **`UploadSnapshotPushService.js`**: a separate pipeline (local temp dir → Kafka `file://` handoff), zero S3 involvement. Needs its own product decision on whether it's still in active use before touching.
- **`tenantFolderName.js`**: now dead code (no callers) after `PersonService` moved off it — not deleted here, flagged for a follow-up cleanup PR.
- **Bare-filename resolver ambiguity**: `photoResolverService.resolvePhotoByFilename` matches by `ILIKE %filename%`, which assumes filenames are unique. This migration introduced one new fixed, cross-employee-identical filename (`profile.jpg`) and solved it with a dedicated route (`GET /api/employees/:id/profile-photo`, streams directly from a key built from the known `employeeId`). The same latent ambiguity exists for the now-stable enrollment filenames (`front.jpg`, `left.jpg`, etc. — every employee's front-angle photo shares that literal name) when served via the generic `/api/jetson/photos/:filename` route; it isn't fixed here since it predates this migration (the old `image_{angle}.jpg` convention had the same property) and fixing it fully means auditing every bare-filename serving route, not just this migration's touch points.

## Verification (run against a real environment + its own bucket pair)
For each flow: hit the endpoint, then confirm the HTTP response, the DB row, and the actual S3 object.

```bash
# --- A.1 HR Direct Enrollment ---
curl -s -X POST $API/employees/$EMP_ID/enroll-face -H "Authorization: Bearer $TOKEN" -F "photo=@front.jpg" -F "angle=front"
psql $DATABASE_URL -c "SELECT photo_path FROM employee_face_embeddings WHERE employee_id=$EMP_ID ORDER BY enrolled_at DESC LIMIT 1;"
aws s3 ls s3://$USER_DATA_BUCKET/tenant-$TENANT_ID/users/$EMP_CODE/enrollment/
aws s3 ls s3://$USER_DATA_BUCKET/tenant-$TENANT_ID/users/$EMP_CODE/profile/   # front angle only

# --- A.2 enroll-face-direct (device) ---
curl -s -X POST $API/employees/$EMP_ID/enroll-face-direct -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"embedding":[...512 floats...],"confidence":0.9,"photo_path":"tenant-'$TENANT_ID'/users/'$EMP_CODE'/enrollment/front.jpg"}'
curl -s -X POST $API/employees/$EMP_ID/enroll-face-direct -H "Authorization: Bearer $DEVICE_TOKEN" \
  -d '{"embedding":[...],"photo_path":"/etc/passwd"}'   # expect 400

# --- A.3 enroll-remote ---
curl -s -X POST $API/employees/$EMP_ID/enroll-remote -H "Authorization: Bearer $TOKEN" -F "photo=@front.jpg" -F "angle=front"
psql $DATABASE_URL -c "SELECT command_payload FROM device_command_queue WHERE command_type='enroll_from_photo' ORDER BY created_at DESC LIMIT 1;"
aws s3 ls s3://$USER_DATA_BUCKET/tenant-$TENANT_ID/users/$EMP_CODE/enrollment/front.jpg
pm2 logs frs-backend --lines 50   # confirm no ReferenceError

# --- B self-enrollment portal ---
curl -s -X POST $API/enroll/$INVITE_TOKEN/upload-angle -F "photo=@front.jpg" -F "angle=front"
psql $DATABASE_URL -c "SELECT photo_paths FROM enrollment_invitations WHERE pk_invitation_id=$INV_ID;"
aws s3 ls s3://$USER_DATA_BUCKET/tenant-$TENANT_ID/users/$EMP_CODE/profile/profile.jpg

# --- C profile photo read path ---
curl -s $API/employees/$EMP_ID/photo -H "Authorization: Bearer $TOKEN"          # {url: "/api/employees/.../profile-photo"}
curl -s $API/employees/$EMP_ID/profile-photo -H "Authorization: Bearer $TOKEN" -o out.jpg   # actual bytes

# --- D device event photos (both paths) ---
curl -s -X POST $API/events -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"event_type":"attendance.checkin","payload":{"employee_code":"'$EMP_CODE'","photo_base64":"'$(base64 -w0 test.jpg)'","event_time":"2026-07-23T09:00:00Z"}}'
aws s3 ls s3://$LOGS_BUCKET/tenant-$TENANT_ID/employee/$EMP_CODE/2026-07-23/in/

curl -s -X POST $API/events/photo -H "Authorization: Bearer $DEVICE_TOKEN" -F "photo=@test.jpg" -F "employee_code=$EMP_CODE" -F "direction=in"
aws s3 ls s3://$LOGS_BUCKET/tenant-$TENANT_ID/employee/$EMP_CODE/
curl -s -X POST $API/events/photo -H "Authorization: Bearer $DEVICE_TOKEN" -F "photo=@test.jpg"   # no identity — staging key
aws s3 ls s3://$LOGS_BUCKET/tenant-$TENANT_ID/_incoming/

# --- E legacy recognize/mark pipeline ---
curl -s -X POST $API/face/recognize -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"embedding":[...512 unmatched floats...],"frame":"'$(base64 -w0 test.jpg)'"}'
psql $DATABASE_URL -c "SELECT person_id, photo_url FROM person ORDER BY created_at DESC LIMIT 1;"
aws s3 ls s3://$LOGS_BUCKET/tenant-$TENANT_ID/visitor/    # Visitor_{personId}_... filename

# --- F visitor registration ---
curl -s -X POST $API/visitors -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fullName":"Test Visitor","organization":"Acme","photoUrl":"data:image/jpeg;base64,'$(base64 -w0 test.jpg)'","validFrom":"2026-07-23","validTo":"2026-07-24"}'
psql $DATABASE_URL -c "SELECT person_id, photo_url FROM person WHERE full_name='Test Visitor' ORDER BY created_at DESC LIMIT 1;"
aws s3 ls s3://$LOGS_BUCKET/tenant-$TENANT_ID/visitor/$PERSON_ID/

# --- Unit tests ---
node --test src/tests/s3Storage.test.js
```

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| `Missing S3 bucket for key` | `AWS_S3_LOGS_BUCKET`/`AWS_S3_USER_DATA_BUCKET` unset | set in `.env`, reload the process |
| Enrollment upload 500s with `sanitizeForKey is not defined` | Pre-fix bug in `enroll-remote` | fixed in this migration — if seen again, check the import at the top of `employeeRoutes.js` wasn't reverted |
| Photo 404s via `/api/jetson/photos/:filename` | Filename collides across employees/tenants, or object never uploaded | check the owning row's column directly (`employee_face_embeddings.photo_path`, etc.) rather than trusting the resolver in ambiguous cases |
| `photo_path must be a tenant-scoped S3 key` (400) | `enroll-face-direct` received a `photo_path` not starting with `tenant-` | expected — device firmware should only ever pass back a key this backend itself issued |
