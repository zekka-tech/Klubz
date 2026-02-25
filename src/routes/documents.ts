/**
 * Klubz - Driver Document Upload & Verification Routes
 *
 * GET  /api/users/documents              — List own documents
 * POST /api/users/documents/upload-url   — Get a pre-signed R2 upload URL
 * POST /api/users/documents              — Record an upload (after R2 PUT)
 * GET  /api/admin/documents              — Admin: pending document queue
 * PUT  /api/admin/documents/:id          — Admin: approve or reject
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { encryptPII } from '../lib/encryption';
import { logger } from '../lib/logger';

export const documentRoutes = new Hono<AppEnv>();

const DOC_TYPES = ['drivers_license', 'id_document', 'vehicle_registration', 'proof_of_insurance'] as const;

const recordDocumentSchema = z.object({
  fileKey: z.string().min(1),
  docType: z.enum(DOC_TYPES),
  fileName: z.string().max(200).optional(),
}).strict();

const reviewDocumentSchema = z.object({
  status: z.enum(['approved', 'rejected', 'expired']),
  rejectionReason: z.string().max(500).optional(),
  expiresAt: z.string().optional(),
}).strict();

// ── GET /api/users/documents ────────────────────────────────────────────────

documentRoutes.get('/users/documents', authMiddleware(), async (c) => {
  const user = c.get('user');
  const db = getDBOptional(c);
  if (!db) return c.json({ documents: [] });

  const { results } = await db
    .prepare(
      `SELECT id, doc_type, file_key, status, rejection_reason, expires_at, created_at, updated_at
       FROM driver_documents WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(user.id)
    .all<{
      id: number;
      doc_type: string;
      file_key: string;
      status: string;
      rejection_reason: string | null;
      expires_at: string | null;
      created_at: string;
      updated_at: string | null;
    }>();

  return c.json({ documents: results ?? [] });
});

// ── POST /api/users/documents/upload-url ───────────────────────────────────

documentRoutes.post('/users/documents/upload-url', authMiddleware(), async (c) => {
  const user = c.get('user');
  const storage = c.env?.STORAGE;
  if (!storage) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Storage not configured' } }, 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const docType = (body as { docType?: string })?.docType;
  if (!DOC_TYPES.includes(docType as typeof DOC_TYPES[number])) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid document type' } }, 400);
  }

  const fileKey = `users/${user.id}/docs/${crypto.randomUUID()}.pdf`;

  // R2 does not provide pre-signed URLs in the Workers binding model.
  // We return the fileKey and a signed upload token stored in SESSIONS KV.
  // The client will POST the file to our /api/users/documents/r2-upload endpoint.
  const uploadToken = crypto.randomUUID();
  const sessions = c.env?.SESSIONS;
  if (!sessions) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Session service unavailable' } }, 503);
  }
  await sessions.put(
    `r2upload:${uploadToken}`,
    JSON.stringify({ userId: user.id, fileKey, docType }),
    { expirationTtl: 300 }, // 5 min
  );

  return c.json({ uploadToken, fileKey, docType });
});

// ── POST /api/users/documents/r2-upload?uploadToken=... ────────────────────

documentRoutes.post('/users/documents/r2-upload', authMiddleware(), async (c) => {
  const user = c.get('user');
  const storage = c.env?.STORAGE;
  const sessions = c.env?.SESSIONS;

  if (!storage || !sessions) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Storage service unavailable' } }, 503);
  }

  const uploadToken = c.req.query('uploadToken');
  if (!uploadToken) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'uploadToken is required' } }, 400);
  }

  const tokenKey = `r2upload:${uploadToken}`;
  const tokenPayload = await sessions.get(tokenKey, 'text');
  if (!tokenPayload) {
    return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Upload token is invalid or expired' } }, 401);
  }

  let parsedToken: { userId: number; fileKey: string; docType: string } | null = null;
  try {
    parsedToken = JSON.parse(tokenPayload) as { userId: number; fileKey: string; docType: string };
  } catch {
    await sessions.delete(tokenKey);
    return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Upload token is invalid' } }, 401);
  }

  if (!parsedToken || parsedToken.userId !== user.id) {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Upload token does not belong to this user' } }, 403);
  }

  // One-time token: consume before writing.
  await sessions.delete(tokenKey);

  const maxBytes = 10 * 1024 * 1024; // 10 MB
  const contentLengthHeader = c.req.header('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB limit' } }, 413);
    }
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > maxBytes) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB limit' } }, 413);
  }

  const contentType = c.req.header('content-type') || 'application/octet-stream';
  try {
    await storage.put(parsedToken.fileKey, body, {
      httpMetadata: { contentType },
      customMetadata: { userId: String(user.id), docType: parsedToken.docType },
    });
    return c.json({ success: true, fileKey: parsedToken.fileKey });
  } catch (err) {
    logger.error('R2 upload failed', err instanceof Error ? err : undefined, { userId: user.id });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload document' } }, 500);
  }
});

// ── POST /api/users/documents ───────────────────────────────────────────────

documentRoutes.post('/users/documents', authMiddleware(), async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = recordDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid document data' } }, 400);
  }

  const { fileKey, docType, fileName } = parsed.data;
  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  const encKey = c.env?.ENCRYPTION_KEY;
  let encFileName: string | null = null;
  if (fileName && encKey) {
    encFileName = await encryptPII(fileName, encKey, user.id).catch(() => null);
  }

  try {
    const result = await db
      .prepare(
        `INSERT INTO driver_documents (user_id, doc_type, file_key, file_name_encrypted)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(user.id, docType, fileKey, encFileName)
      .run();

    return c.json({ documentId: result.meta?.last_row_id, status: 'pending' }, 201);
  } catch (err) {
    logger.error('document record failed', err instanceof Error ? err : undefined, { userId: user.id });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to record document' } }, 500);
  }
});

// ── GET /api/admin/documents ────────────────────────────────────────────────

documentRoutes.get('/admin/documents', adminMiddleware(), async (c) => {
  const status = c.req.query('status') || 'pending';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = Math.min(50, parseInt(c.req.query('limit') || '20'));
  const offset = (page - 1) * limit;

  const db = getDBOptional(c);
  if (!db) return c.json({ documents: [], pagination: { page, limit, total: 0, totalPages: 0 } });

  const { results } = await db
    .prepare(
      `SELECT d.id, d.user_id, d.doc_type, d.file_key, d.status, d.rejection_reason,
              d.expires_at, d.created_at, u.email as user_email
       FROM driver_documents d
       JOIN users u ON u.id = d.user_id
       WHERE d.status = ?
       ORDER BY d.created_at ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(status, limit, offset)
    .all<{
      id: number;
      user_id: number;
      doc_type: string;
      file_key: string;
      status: string;
      rejection_reason: string | null;
      expires_at: string | null;
      created_at: string;
      user_email: string;
    }>();

  const total = await db
    .prepare('SELECT COUNT(*) as cnt FROM driver_documents WHERE status = ?')
    .bind(status)
    .first<{ cnt: number }>();

  return c.json({
    documents: results ?? [],
    pagination: {
      page,
      limit,
      total: total?.cnt ?? 0,
      totalPages: Math.ceil((total?.cnt ?? 0) / limit),
    },
  });
});

// ── PUT /api/admin/documents/:id ────────────────────────────────────────────

documentRoutes.put('/admin/documents/:id', adminMiddleware(), async (c) => {
  const admin = c.get('user');
  const docId = parseInt(c.req.param('id'));
  if (isNaN(docId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid document ID' } }, 400);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = reviewDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid review data' } }, 400);
  }

  const { status, rejectionReason, expiresAt } = parsed.data;
  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  const doc = await db
    .prepare('SELECT id, user_id FROM driver_documents WHERE id = ?')
    .bind(docId)
    .first<{ id: number; user_id: number }>();

  if (!doc) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found' } }, 404);
  }

  await db
    .prepare(
      `UPDATE driver_documents
       SET status = ?, rejection_reason = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP,
           expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, rejectionReason || null, admin.id, expiresAt || null, docId)
    .run();

  // If approved, check if all required docs are now approved → set documents_verified
  if (status === 'approved') {
    const requiredDocs = DOC_TYPES;
    const { results: approved } = await db
      .prepare(
        `SELECT doc_type FROM driver_documents WHERE user_id = ? AND status = 'approved'`,
      )
      .bind(doc.user_id)
      .all<{ doc_type: string }>();

    const approvedTypes = new Set((approved ?? []).map((d) => d.doc_type));
    const allApproved = requiredDocs.every((t) => approvedTypes.has(t));
    if (allApproved) {
      await db
        .prepare('UPDATE users SET documents_verified = 1 WHERE id = ?')
        .bind(doc.user_id)
        .run();
    }
  }

  return c.json({ success: true, documentId: docId, status });
});

export default documentRoutes;
