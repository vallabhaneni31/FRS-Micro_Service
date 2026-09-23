/**
 * requireDeviceScope.js — gates a device-authenticated route behind a scope
 * claim on the device's JWT. Must run after authenticateDevice (needs req.device).
 *
 * No device token minted so far carries a `scope` claim at all, so a missing
 * claim is treated as legacy/allowed rather than denied — otherwise every
 * already-activated device (e.g. jetson-box-1) would be locked out of scoped
 * routes until it re-runs ZTP activation. Enforcement only kicks in once a
 * token actually carries a scope claim that's missing the required one.
 */
export default function requireDeviceScope(requiredScope) {
  return (req, res, next) => {
    const scope = req.device?.scope;
    if (!scope) return next();

    const granted = String(scope).split(/\s+/).filter(Boolean);
    if (!granted.includes(requiredScope)) {
      return res.status(403).json({ message: `device token missing required scope: ${requiredScope}` });
    }
    next();
  };
}
