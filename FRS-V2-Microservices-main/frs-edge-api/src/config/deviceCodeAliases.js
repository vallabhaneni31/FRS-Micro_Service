/**
 * deviceCodeAliases.js — known device-code renames.
 *
 * Renaming facility_device.external_device_id doesn't change the device_code
 * claim baked into an already-issued device JWT (authenticateDevice.js reads
 * it straight from the token, not fresh from the DB) — so a device can keep
 * presenting its old code until it's reissued a token. Anywhere that does a
 * find-or-create-by-device_code against the `devices` table must resolve
 * through this map first, or a stale-token device recreates a second
 * orphaned identity every time it's renamed (see jetson-09 <-> jetson-09-paused,
 * reconciled 2026-07-23 — memory: jetson-device-identity-mismatch).
 *
 * Update this map whenever a device is renamed and its physical token hasn't
 * been rotated yet; remove the entry once the device is confirmed on a token
 * carrying the new code.
 */
export const DEVICE_CODE_ALIASES = {
  'jetson-09-paused': 'jetson-09',
};

export function resolveDeviceCodeAlias(deviceCode) {
  return DEVICE_CODE_ALIASES[deviceCode] || deviceCode;
}
