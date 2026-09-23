# S3 Storage Migration for Jetson Data, Enrollment Photos & Profiles
This plan details the migration from local VM file storage (`/uploads/*`) to AWS S3 buckets.

Currently, face recognition event photos, enrollment photos, and visitor profile photos are stored directly on the VM server disk. We want to move these to two separate S3 buckets:
1. **S3 Bucket - 1 (Logs)**: Temporal check-in/out and unrecognized face logs.
2. **S3 Bucket - 2 (User Data) Permanent Data**: Permanent face enrollment photos and primary profile photos.

The migration will enforce the bucket and key directory structures outlined below.

---

## User Review Required

> [!IMPORTANT]
> **Image Fetching Method: Backend Proxying vs. Direct S3 Pre-signed URLs**
> We have two options for serving images to the UI:
> - **Option A: Backend Proxy/Streaming (Recommended)**: Keep the existing `/uploads/*` and `/api/jetson/photos/*` URL routes. When the frontend requests an image, the backend validates access, checks tenant scope ownership, downloads the file from S3, and streams it.
>   - *Pros*: Completely transparent to the frontend; no frontend code changes are needed. Strict authorization policies (`verifyPhotoAccess` and `tenantOwnsPhoto`) remain identical.
>   - *Cons*: VM server still handles the egress bandwidth of the images.
> - **Option B: Direct S3 Pre-signed URLs**: Modify the backend API response to generate and return a short-lived S3 pre-signed URL (e.g. valid for 15 minutes) for each image.
>   - *Pros*: Offloads all image delivery traffic from the VM server to S3.
>   - *Cons*: Requires updating the frontend's [authedPhoto.ts](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/frontend/src/app/services/http/authedPhoto.ts) logic to remove Keycloak `Authorization` headers when fetching directly from S3 (otherwise S3 will reject with `400 Bad Request`). Also requires updating all image-returning endpoints to dynamically generate URLs upon request.
> 
> *Our recommendation is Option A (Backend Proxy) for immediate reliability and security isolation, with a path to shift to Option B if VM network egress becomes a bottleneck.*

---

## Open Questions

> [!WARNING]
> **1. Data Retention & Purging for Enrollment Photos**
> Currently, [photoPurgeCron.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/jobs/photoPurgeCron.js) runs hourly to permanently delete enrollment photos 24 hours after embeddings are created (to comply with GDPR data minimization guidelines).
> However, the new S3 structure designates S3 Bucket 2 as **"Permanent Data"** containing **"Enrollment Photos"**.
> *Should we keep the purge behavior on S3 Bucket 2 (deleting enrollment photos after embedding completion), or does "Permanent Data" mean we should keep them indefinitely?*

> [!NOTE]
> **2. Unknown/Buffered Visitor Log Location**
> In the new logs bucket structure, visitor check-in photos are stored under:
> `{tenantId}/Visitor/{visitorId}/{date}/In` (or `Out`).
> For **unrecognized / unknown** faces (where the visitor hasn't been validated/promoted to the `person` table yet), they are temporarily buffered in `visitor_buffer`.
> *We propose saving buffered/unrecognized visitor photos under `{tenantId}/Visitor/{bufferedUuid}/{date}/In/` using the generated visitor UUID to keep S3 structures consistent and secure.*

---

## Proposed Changes

### Core Storage & Environment Config

#### [MODIFY] [package.json](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/package.json)
- Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to backend dependencies.

#### [MODIFY] [env.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/config/env.js)
- Add environment variables:
  - `AWS_ACCESS_KEY_ID` (AWS credentials)
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_REGION`
  - `AWS_S3_LOGS_BUCKET` (Bucket 1 for logs)
  - `AWS_S3_USER_DATA_BUCKET` (Bucket 2 for permanent data)
  - `AWS_S3_ENDPOINT` (optional, for local development / testing)
  - `AWS_S3_FORCE_PATH_STYLE` (optional)

#### [NEW] [storageService.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/services/storageService.js)
- Build a centralized S3 storage abstraction:
  - `uploadFile(bucket, key, buffer, contentType)`: Upload buffer to S3.
  - `deleteFile(bucket, key)`: Delete object from S3.
  - `getFileStream(bucket, key)`: Retrieve readable stream from S3 (for Option A).
  - `getDownloadUrl(bucket, key, expiresSeconds)`: Generate pre-signed GET URL (for Option B).

---

### Backend Logic Updates

#### [MODIFY] [DeviceEventService.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/services/business/DeviceEventService.js)
- In `processEvent`, instead of saving Jetson event photos to local disk (`uploads/attendance-photos/`), upload directly to S3 Logs Bucket:
  - Resolve identification ID (Employee ID, Visitor ID, or temporary UUID) first.
  - Upload to S3 key structures:
    - **Employees**: `{tenantId}/{employeeId}/{dateStr}/{Direction}/{filename}`
    - **Visitors**: `{tenantId}/Visitor/{visitorId}/{dateStr}/{Direction}/{filename}`
    - **Filename rule**: Use a unique timestamped suffix (`img_${Date.now()}_${Math.floor(Math.random() * 10000)}.jpg`) to allow multiple photos (check-ins/check-outs) for the same employee/visitor on the same day.
  - Save S3 Key references as the database `photo_url` / `photo_path`.

#### [MODIFY] [EnrollmentService.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/services/business/EnrollmentService.js)
- In `uploadEnrollmentPhoto`, save upload angle photo buffers directly to S3 User Data Bucket:
  - Key: `{tenantId}/{id}/Enrollment Photos/{angle}.jpg` (overwriting the angle on subsequent remote enrollment attempts).
- Update `createEmbeddingsFromPhotos` to download photo buffers from S3 instead of reading from local disk using `fs.readFile`.

#### [MODIFY] [PersonService.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/services/business/PersonService.js)
- Refactor the external helper `saveBase64Image` to accept `tenantId` and `personId` (or visitor ID).
- Instead of writing to local disk, upload to S3 User Data Bucket:
  - Key: `{tenantId}/{visitorId}/Profile/{filename}` (where `{filename}` is a timestamped visitor photo to keep profile changes unique).

#### [MODIFY] [employeeRoutes.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/routes/employeeRoutes.js)
- Update remote-enrollment upload logic (HR UI-driven) to save enrollment photos to S3 User Data Bucket:
  - Key: `{tenantId}/{employeeId}/Enrollment Photos/{angle}.jpg`

#### [MODIFY] [gdprErasureService.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/services/gdprErasureService.js)
- Update file purging step to delete employee photos from S3 User Data Bucket instead of running `fs.unlinkSync`.

#### [MODIFY] [photoPurgeCron.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/jobs/photoPurgeCron.js)
- Delete processed enrollment photos from S3 User Data Bucket (depending on the outcome of Open Question 1).

---

### Endpoint Serving & Routing

#### [MODIFY] [server.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/server.js)
- Update `/uploads/*` static router to parse paths, fetch requested files from S3, and stream them back to the client.

#### [MODIFY] [jetsonRoutes.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/routes/jetsonRoutes.js)
- Update the `/photos/:filename` route to resolve the S3 Key from the database, fetch the image from S3, and stream it to the client.

---

### Data Migration

#### [NEW] [migrate_to_s3.js](file:///home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/scripts/migrate_to_s3.js)
- Add a standalone, idempotent data migration script to move existing files to S3:
  1. Scan `/uploads/attendance-photos`, match filenames against `attendance_record.checkin_photo_url`/`checkout_photo_url`, determine the correct tenant/employee/date path, upload to S3 Logs Bucket, and update SQL records.
  2. Scan `/uploads/remote-enrollment` and `/uploads/enrollment-photos`, match filenames against `enrollment_invitations.photo_paths` and `employee_face_embeddings.photo_path`/`person_face_embeddings.photo_path`, upload to S3 User Data Bucket under the correct keys, and update database records.

---

## Verification Plan

### Automated Tests
- Write S3 mock helper integration tests (`backend/api/src/tests/s3Storage.test.js`) using local mocked S3 responses to verify:
  - Structured key path generation.
  - S3 upload, stream download, and delete commands.
- Run tests:
  ```bash
  npm run test
  ```

### Manual Verification
1. Configure credentials for a local/test S3 (MinIO or AWS sandbox bucket).
2. Execute the migration script: `node scripts/migrate_to_s3.js` and verify database records are successfully updated and files are present on S3.
3. Trigger a face check-in event using the simulated Jetson event scripts:
   ```bash
   node scripts/simulate_edge_connection.js
   ```
4. Verify that the event photo is successfully uploaded to the S3 logs bucket under the tenant/employee path.
5. Access the HR Dashboard and verify attendance images render correctly in the UI.
