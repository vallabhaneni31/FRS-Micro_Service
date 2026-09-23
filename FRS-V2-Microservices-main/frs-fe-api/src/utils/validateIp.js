import net from 'net';

/**
 * Validates that the input is a valid IPv4 address.
 * @param {string} ip
 * @returns {boolean}
 */
export function validateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return net.isIPv4(ip);
}

/**
 * Validates that the input is a valid IPv4 address AND is NOT in a restricted range
 * (loopback, link-local, private/RFC1918).
 * @param {string} ip
 * @returns {boolean}
 */
export function validateNugIp(ip) {
  if (!validateIp(ip)) return false;

  const octets = ip.split('.').map(Number);
  
  // 127.0.0.0/8 (Loopback)
  if (octets[0] === 127) return false;

  // 169.254.0.0/16 (Link-local)
  if (octets[0] === 169 && octets[1] === 254) return false;

  // 10.0.0.0/8 (Private)
  if (octets[0] === 10) return false;

  // 172.16.0.0/12 (Private)
  if (octets[0] === 172 && (octets[1] >= 16 && octets[1] <= 31)) return false;

  // 192.168.0.0/16 (Private)
  if (octets[0] === 192 && octets[1] === 168) return false;

  return true;
}
