/**
 * userDeletionEmail.test.js — AB#3240
 *
 * "User deletion does not trigger email notification to the deleted HR Admin/Site Admin user"
 *
 * Verifies that when UserService.deleteUser(id) is called:
 * 1. The user's details (email, username, role, tenant) are fetched prior to cascade deletion.
 * 2. sendAccountDeletionNotification is invoked to send an email notification to the deleted user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Mail from 'nodemailer/lib/mailer/index.js';
import { pool } from '../db/pool.js';
import * as UserService from '../services/business/UserService.js';
import { sendAccountDeletionNotification } from '../services/emailService.js';

test('sendAccountDeletionNotification generates correctly formatted email options (AB#3240)', async (t) => {
  const originalSendMail = Mail.prototype.sendMail;
  let capturedMailOptions = null;

  Mail.prototype.sendMail = async function (options) {
    capturedMailOptions = options;
    return { messageId: 'test-deletion-msg-id-123' };
  };

  t.after(() => {
    Mail.prototype.sendMail = originalSendMail;
  });

  const result = await sendAccountDeletionNotification({
    toEmail: 'deleted.admin@motivitylabs.com',
    toName: 'Deleted Admin',
    roleName: 'HR Admin / Site Admin',
    tenantName: 'Motivity Corp',
  });

  assert.strictEqual(result.success, true);
  assert.ok(capturedMailOptions, 'transporter.sendMail should be invoked');
  assert.strictEqual(capturedMailOptions.to, 'deleted.admin@motivitylabs.com');
  assert.ok(capturedMailOptions.subject.includes('Account Access Has Been Revoked'));
  assert.ok(capturedMailOptions.html.includes('deleted.admin@motivitylabs.com'));
  assert.ok(capturedMailOptions.html.includes('HR Admin / Site Admin'));
  assert.ok(capturedMailOptions.html.includes('Motivity Corp'));
});

test('deleteUser fetches user and triggers sendAccountDeletionNotification (AB#3240)', async (t) => {
  const originalQuery = pool.query;
  let sendMailCalled = false;
  let deletedEmail = '';

  const originalSendMail = Mail.prototype.sendMail;
  Mail.prototype.sendMail = async function (options) {
    sendMailCalled = true;
    deletedEmail = options.to;
    return { messageId: 'test-msg-456' };
  };

  pool.query = async (sql, params) => {
    const text = typeof sql === 'string' ? sql : sql?.text || '';
    if (text.includes('SELECT u.pk_user_id, u.email')) {
      return {
        rows: [
          {
            pk_user_id: 99,
            email: 'admin.user@motivitylabs.com',
            username: 'Admin User',
            role: 'admin',
            tenant_name: 'Test Organization',
          },
        ],
      };
    }
    return { rows: [] };
  };

  t.after(() => {
    pool.query = originalQuery;
    Mail.prototype.sendMail = originalSendMail;
  });

  await UserService.deleteUser(99);

  assert.strictEqual(sendMailCalled, true, 'Email notification should be sent upon user deletion');
  assert.strictEqual(deletedEmail, 'admin.user@motivitylabs.com');
});
