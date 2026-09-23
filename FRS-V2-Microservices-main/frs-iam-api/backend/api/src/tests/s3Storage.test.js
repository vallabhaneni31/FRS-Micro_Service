import test from "node:test";
import assert from "node:assert";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import * as storage from "../services/storageService.js";
import { isLegacyLocalPath } from "../services/photoResolverService.js";

// s3KeyBuilder.js / DeviceEventService.js coverage removed — both moved with
// deviceEventsRoutes.js/the device-event ingest pipeline to frs-edge-api
// during the IAM split. storageService/photoResolverService stay here since
// this service (IAM) still uses them for enrollment/profile photos.

// Mock S3Client.prototype.send so these tests never hit real AWS — every
// storageService call goes through a single S3Client instance whose `send`
// is inherited from this prototype.
function mockSend(t, impl) {
  return t.mock.method(S3Client.prototype, "send", impl);
}

test("storageService.uploadFile sends a PutObjectCommand with bucket/key/body and returns the key", async (t) => {
  let captured = null;
  mockSend(t, async (command) => {
    captured = command;
    return {};
  });

  const key = await storage.uploadFile("my-bucket", "tenant-1/emp-1/2026-07-15/In/img_1.jpg", Buffer.from("fake-jpeg"), "image/jpeg");

  assert.strictEqual(key, "tenant-1/emp-1/2026-07-15/In/img_1.jpg");
  assert.strictEqual(captured.input.Bucket, "my-bucket");
  assert.strictEqual(captured.input.Key, "tenant-1/emp-1/2026-07-15/In/img_1.jpg");
  assert.strictEqual(captured.input.ContentType, "image/jpeg");
  assert.ok(Buffer.isBuffer(captured.input.Body));
});

test("storageService.uploadFile throws when bucket is not configured", async () => {
  await assert.rejects(
    () => storage.uploadFile(undefined, "some/key.jpg", Buffer.from("x")),
    /Missing S3 bucket/
  );
});

test("storageService.deleteFile returns true on successful delete", async (t) => {
  mockSend(t, async () => ({}));
  const result = await storage.deleteFile("my-bucket", "tenant-1/emp-1/photo.jpg");
  assert.strictEqual(result, true);
});

test("storageService.deleteFile returns false (does not throw) when the object is already gone", async (t) => {
  mockSend(t, async () => {
    const err = new Error("not found");
    err.name = "NoSuchKey";
    throw err;
  });
  const result = await storage.deleteFile("my-bucket", "tenant-1/emp-1/photo.jpg");
  assert.strictEqual(result, false);
});

test("storageService.deleteFile re-throws unexpected errors", async (t) => {
  mockSend(t, async () => {
    throw new Error("access denied");
  });
  await assert.rejects(
    () => storage.deleteFile("my-bucket", "tenant-1/emp-1/photo.jpg"),
    /access denied/
  );
});

test("storageService.getFileBuffer concatenates the object stream into a single Buffer", async (t) => {
  mockSend(t, async () => ({
    Body: Readable.from([Buffer.from("hello-"), Buffer.from("world")]),
    ContentType: "image/jpeg",
  }));

  const buf = await storage.getFileBuffer("my-bucket", "tenant-1/emp-1/photo.jpg");
  assert.strictEqual(buf.toString(), "hello-world");
});

test("photoResolverService.isLegacyLocalPath distinguishes pre-migration local paths from S3 keys", () => {
  // Legacy: absolute local disk paths and /uploads/... URLs always start with "/"
  assert.strictEqual(isLegacyLocalPath("/uploads/attendance-photos/img_1.jpg"), true);
  assert.strictEqual(isLegacyLocalPath("/opt/app/backend/api/uploads/enrollment-photos/x.jpg"), true);

  // New S3 keys never have a leading slash — always "{tenantId}/..."
  assert.strictEqual(isLegacyLocalPath("11111111-1111-1111-1111-111111111111/42/2026-07-15/In/img_1.jpg"), false);
  assert.strictEqual(isLegacyLocalPath("11111111-1111-1111-1111-111111111111/Visitor/99/2026-07-15/Out/img_2.jpg"), false);

  assert.strictEqual(isLegacyLocalPath(null), false);
  assert.strictEqual(isLegacyLocalPath(undefined), false);
});

test("photoResolverService.isLegacyLocalPath also treats fully-qualified http(s) URLs as legacy", () => {
  assert.strictEqual(isLegacyLocalPath("https://frs.motivitylabs.com/uploads/attendance-photos/x.jpg"), true);
  assert.strictEqual(isLegacyLocalPath("http://frs.motivitylabs.com/uploads/attendance-photos/x.jpg"), true);
  assert.strictEqual(isLegacyLocalPath("tenant-1/employee/E1/2026-07-23/in/John_2026-07-23_09-00-00-123.jpg"), false);
});
