// src/config.ts
import { URL } from 'node:url';

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  appDatabaseUrl: string;
  dbSsl: 'off' | 'require' | 'no-verify';
  dbPoolMax: number;
  corsOrigins: string[];
  trustProxy: boolean;
  staticDir?: string;
  schedulerEnabled: boolean;
  appUserPassword?: string;
}

export function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const databaseUrl = env.DATABASE_URL || '';
  const appDatabaseUrl = env.APP_DATABASE_URL || '';
  const portStr = env.PORT || (isProduction ? '3000' : '3000');
  const host = env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
  const dbSslEnv = env.DB_SSL || (isProduction ? 'require' : 'off');
  const dbPoolMaxStr = env.DB_POOL_MAX || '10';
  const corsOriginsStr = env.CORS_ORIGINS || '';
  const trustProxy = env.TRUST_PROXY === 'true';
  const staticDir = env.STATIC_DIR || undefined;
  const schedulerEnabled = env.SCHEDULER !== 'off';
  const appUserPassword = env.APP_USER_PASSWORD || undefined;

  const dbSsl: 'off' | 'require' | 'no-verify' = 
    dbSslEnv === 'require' || dbSslEnv === 'no-verify' ? dbSslEnv : 'off';

  const corsOrigins = corsOriginsStr
    ? corsOriginsStr.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : [];

  const port = Number(portStr);
  const dbPoolMax = Number(dbPoolMaxStr);

  if (isProduction) {
    const problems: string[] = [];

    if (!appDatabaseUrl) {
      problems.push('APP_DATABASE_URL is missing');
    } else if (appDatabaseUrl.includes('app_user:app_user@')) {
      problems.push('APP_DATABASE_URL still contains the default development credentials');
    }

    if (!databaseUrl) {
      problems.push('DATABASE_URL is missing');
    }

    if (databaseUrl && appDatabaseUrl && databaseUrl === appDatabaseUrl) {
      problems.push('DATABASE_URL and APP_DATABASE_URL must be different (the server must not run as the owner)');
    }

    if (corsOrigins.length === 0 && !staticDir) {
      problems.push('At least one of CORS_ORIGINS or STATIC_DIR must be set');
    }

    if (corsOrigins.includes('*')) {
      problems.push('CORS_ORIGINS must not contain wildcard "*"');
    }

    if (env.PORT) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push('PORT must be an integer between 1 and 65535');
      }
    }

    if (env.DB_POOL_MAX) {
      if (!Number.isInteger(dbPoolMax) || dbPoolMax < 1 || dbPoolMax > 50) {
        problems.push('DB_POOL_MAX must be an integer between 1 and 50');
      }
    }

    if (problems.length > 0) {
      const redactedProblems = problems.map(p => {
        if (p.includes('DATABASE_URL') || p.includes('APP_DATABASE_URL')) {
          return p;
        }
        return p;
      });
      throw new Error(`Production configuration errors:\n${redactedProblems.join('\n')}`);
    }
  }

  return {
    nodeEnv,
    port: Number.isInteger(port) && port > 0 ? port : 3000,
    host,
    databaseUrl,
    appDatabaseUrl,
    dbSsl,
    dbPoolMax: Number.isInteger(dbPoolMax) && dbPoolMax > 0 ? dbPoolMax : 10,
    corsOrigins,
    trustProxy,
    staticDir,
    schedulerEnabled,
    appUserPassword
  };
}