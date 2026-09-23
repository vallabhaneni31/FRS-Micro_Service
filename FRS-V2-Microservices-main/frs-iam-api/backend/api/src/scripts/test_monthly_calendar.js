import { getMonthlyCalendar } from '../repositories/liveRepository.js';
import { pool } from '../db/pool.js';

async function test() {
  try {
    console.log('Testing getMonthlyCalendar with null tenantId...');
    const rowsNull = await getMonthlyCalendar(null, null, 2026, 7);
    console.log('✅ null tenantId result count:', rowsNull.length);

    console.log('Testing getMonthlyCalendar with tenantId...');
    const rowsTenant = await getMonthlyCalendar('5aa1dbdd-d15f-4766-bdd7-6ca864cbd065', null, 2026, 7);
    console.log('✅ tenant result count:', rowsTenant.length);
  } catch (err) {
    console.error('❌ Query failed:', err);
  } finally {
    await pool.end();
  }
}

test();
