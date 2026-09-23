const fs = require('fs');
const file = '/home/ubuntu/FRS_DEV/Motivity-Face_Recognition_System/backend/api/src/repositories/deviceManagementRepository.js';
let content = fs.readFileSync(file, 'utf8');

// 1. findSiteBelongingToTenant
content = content.replace(
  /WHERE s.pk_site_id = \$1 AND c.fk_tenant_id = \$2::uuid/g,
  "WHERE s.pk_site_id = $1 AND ($2::uuid IS NULL OR c.fk_tenant_id = $2::uuid)"
);

// 2. findDeviceByTenantCode
content = content.replace(
  /WHERE tenant_id = \$1 AND external_device_id = \$2/g,
  "WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2"
);

// 3. findDeviceByCodeTx (this also matches WHERE tenant_id = $1 AND external_device_id = $2, so it's already covered by the replacement above)

// 4. getDeviceDetails
content = content.replace(
  /WHERE fd.tenant_id = \$1 AND fd.external_device_id = \$2/g,
  "WHERE ($1::uuid IS NULL OR fd.tenant_id = $1::uuid) AND fd.external_device_id = $2"
);

// 5. findDeviceForDelete
// same as above, handled by #2

// 6. findDeviceForHeartbeat
content = content.replace(
  /WHERE external_device_id = \$1 AND tenant_id = \$2::uuid/g,
  "WHERE external_device_id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)"
);

// Let's modify the parameter arrays to ensure tenantId || null is passed where needed?
// No, the `pg` driver complains if a parameter is `undefined`, but it allows `null`.
// Since the controller passes `req.auth?.scope?.tenantId || null`, it's already null.

fs.writeFileSync(file, content);
console.log('Done fixing repository.');
