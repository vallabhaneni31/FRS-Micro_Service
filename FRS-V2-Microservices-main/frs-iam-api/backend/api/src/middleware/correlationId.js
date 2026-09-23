/**
 * correlationId.js — W-06
 * Attaches a unique X-Request-ID to every request/response.
 * Accepts an upstream ID from a trusted proxy, otherwise generates one.
 * The frontend ApiError class already reads this header and surfaces it
 * in error messages so support staff can trace issues in logs.
 */
import { v4 as uuidv4 } from 'uuid';

export function correlationIdMiddleware(req, res, next) {
  // Accept a pre-set ID from a trusted upstream (e.g. load-balancer) or generate
  const id = (req.headers['x-request-id'] || uuidv4()).slice(0, 36);
  req.correlationId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
