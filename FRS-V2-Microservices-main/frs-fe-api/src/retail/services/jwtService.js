import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

/** Generate a unique per-device secret */
export function generateDeviceSecret() {
  return randomBytes(48).toString('hex');
}

/** Issue a device JWT signed with the device's own secret */
export function issueDeviceToken(deviceId, secret) {
  return jwt.sign({ sub: deviceId, type: 'retail_device' }, secret, {
    expiresIn: '365d',
    algorithm: 'HS256',
  });
}
