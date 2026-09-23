#!/usr/bin/env node
import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const DEVICE_JWT_SECRET = process.env.DEVICE_JWT_SECRET;
if (!DEVICE_JWT_SECRET) {
    console.error('[FATAL] DEVICE_JWT_SECRET is required (no fallback). Set it in .env or the environment.');
    process.exit(1);
}

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'attendance_intelligence',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

function generateDeviceToken(device, expiresIn = '365d') {
    const payload = {
        device_id: device.pk_device_id,
        external_device_id: device.external_device_id,
        tenant_id: device.tenant_id,
        type: 'device',
        issued_at: new Date().toISOString()
    };
    
    const options = { algorithm: 'HS256' };
    if (expiresIn && expiresIn !== 'never') {
        options.expiresIn = expiresIn;
    }
    
    return jwt.sign(payload, DEVICE_JWT_SECRET, options);
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node generate-device-token.mjs <DEVICE_CODE>');
        console.log('Example: node generate-device-token.mjs NUG001');
        await pool.end();
        return;
    }
    
    const externalDeviceId = args[0];
    
    try {
        const result = await pool.query(`
            SELECT 
                pk_device_id,
                external_device_id,
                tenant_id,
                site_id,
                status
            FROM facility_device
            WHERE external_device_id = $1
        `, [externalDeviceId]);
        
        if (result.rows.length === 0) {
            console.error(`❌ Device not found: ${externalDeviceId}`);
            await pool.end();
            return;
        }
        
        const device = result.rows[0];
        
        console.log('\n📱 Device Information:');
        console.log(`   ID: ${device.pk_device_id}`);
        console.log(`   Code: ${device.external_device_id}`);
        console.log(`   Tenant: ${device.tenant_id}`);
        console.log(`   Site: ${device.site_id || 'None'}`);
        console.log(`   Status: ${device.status}`);
        
        const token = generateDeviceToken(device, '365d');
        
        console.log('\n🔑 Generated Device Token:');
        console.log('─'.repeat(80));
        console.log(token);
        console.log('─'.repeat(80));
        
        console.log('\n✅ Token generated successfully!');
        console.log('\nNext steps:');
        console.log('1. Copy the token above');
        console.log('2. SSH to the Jetson device (see infra/native-deploy or your device inventory for its IP)');
        console.log('3. Create token file: sudo nano /opt/frs/device_token.txt');
        console.log('4. Paste the token and save');
        console.log('5. Restart service: sudo systemctl restart frs-runner.service');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
    
    await pool.end();
}

main();
