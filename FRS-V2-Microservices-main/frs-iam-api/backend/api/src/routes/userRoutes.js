/**
 * userRoutes.js — Admin user management
 * GET    /api/users              list users (with last_login + is_active)
 * POST   /api/users              create user + send welcome email
 * PUT    /api/users/:id          update name / role / department
 * PUT    /api/users/:id/password send a self-service password-reset link (AB#3270)
 * PUT    /api/users/:id/activate   activate user
 * PUT    /api/users/:id/deactivate deactivate user
 * DELETE /api/users/:id          delete user
 *
 * Business logic lives in services/business/UserService.js, backed by
 * repositories/userRepository.js. This file only wires
 * routes -> middleware -> controller.
 */
import express from 'express';
import { requireAuth } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import UserController from '../controllers/UserController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

router.use(requireAuth);

router.get('/', ac(UserController.listUsers));
router.post('/', ac(UserController.createUser));
router.put('/:id', ac(UserController.updateUser));
router.put('/:id/password', ac(UserController.resetPassword));
router.put('/:id/deactivate', ac(UserController.deactivateUser));
router.put('/:id/activate', ac(UserController.activateUser));
router.delete('/:id', ac(UserController.deleteUser));
router.post('/sync-keycloak', ac(UserController.syncKeycloak));

export { router as userRoutes };
