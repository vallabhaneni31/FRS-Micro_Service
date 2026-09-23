/**
 * displayNameValidation.test.js — AB#3239
 *
 * "User is created successfully without entering the mandatory Display Name field"
 *
 * TenantAdminController/TenantAdminService coverage moved with tenantAdminRoutes.js
 * to frs-fe-api during the IAM split — this repo now only owns UserController/
 * UserService, so only that coverage stays here.
 *
 * Verifies that:
 * 1. UserController.createUser rejects user creation with 400 Bad Request when username / Display Name is missing or empty.
 * 2. UserService.createUser throws ValidationError when username / Display Name is missing or empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import UserController from '../controllers/UserController.js';
import * as UserService from '../services/business/UserService.js';

test('UserController.createUser rejects missing or whitespace username (AB#3239)', async () => {
  const req = {
    body: { email: 'test.user@motivitylabs.com', username: '   ', role: 'hr' },
  };

  let responseStatus = null;
  let responseJson = null;

  const res = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseJson = body;
      return this;
    },
  };

  await UserController.createUser(req, res);

  assert.strictEqual(responseStatus, 400);
  assert.strictEqual(responseJson.message, 'Display Name is required.');
});

test('UserService.createUser throws ValidationError when username is empty (AB#3239)', async () => {
  await assert.rejects(
    async () => {
      await UserService.createUser(null, {
        email: 'user@domain.com',
        username: '',
        role: 'hr',
      });
    },
    (err) => {
      return err.name === 'ValidationError' && err.message === 'Display Name is required.';
    }
  );
});
