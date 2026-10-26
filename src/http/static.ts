import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.map': 'application/json'
};

function resolveSafePath(dir: string, requestPath: string): string | null {
  try {
    const decoded = decodeURIComponent(requestPath);
    if (decoded.includes('\0')) return null;
    
    const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded;
    const resolved = path.resolve(dir, relative);
    const normalizedDir = path.resolve(dir);
    
    if (!resolved.startsWith(normalizedDir + path.sep) && resolved !== normalizedDir) {
      return null;
    }
    
    return resolved;
  } catch {
    return null;
  }
}

async function serveFile(reply: FastifyReply, filePath: string, isAsset: boolean): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  
  reply.header('Content-Type', contentType);
  reply.header('Content-Length', stats.size);
  
  if (isAsset) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    reply.header('Cache-Control', 'no-cache');
  }
  
  if (ext === '.html') {
    reply.header('Content-Security-Policy', 
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  }
  
  const stream = fs.createReadStream(filePath);
  return reply.send(stream);
}

export function registerStatic(app: FastifyInstance, dir: string): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;
    
    const queryIndex = url.indexOf('?');
    const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
    
    if (pathname.startsWith('/api/') || pathname === '/health') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    
    const safePath = resolveSafePath(dir, pathname);
    if (!safePath) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    
    try {
      const stats = await fs.promises.stat(safePath);
      if (stats.isFile()) {
        const isAsset = pathname.startsWith('/assets/');
        return serveFile(reply, safePath, isAsset);
      }
    } catch {
      // File doesn't exist, continue to SPA fallback logic
    }
    
    const lastSegment = pathname.split('/').pop() || '';
    const hasDot = lastSegment.includes('.');
    
    if (!hasDot) {
      const indexPath = path.join(dir, 'index.html');
      try {
        await fs.promises.stat(indexPath);
        return serveFile(reply, indexPath, false);
      } catch {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
    }
    
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  };

  app.route({
    method: ['GET'],
    url: '/',
    handler
  });

  app.route({
    method: ['GET'],
    url: '/*',
    handler
  });
}