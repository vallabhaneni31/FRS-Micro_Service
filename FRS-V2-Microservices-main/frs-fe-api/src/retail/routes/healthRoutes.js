import express from 'express';
import { pool } from '../db/pool.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({
      status: 'ok',
      service: 'motivity-frs-retail-api',
      version: '1.0.0',
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: 'degraded',
      service: 'motivity-frs-retail-api',
      db: 'disconnected',
      error: err.message,
    });
  }
});

export { router as healthRoutes };
