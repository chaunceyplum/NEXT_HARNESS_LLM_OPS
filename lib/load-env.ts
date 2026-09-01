import { existsSync } from 'node:fs';

/** Load .env.local into process.env if present — scripts here aren't run under Next.js, which normally does this automatically. */
export function loadEnvLocal(): void {
  if (existsSync('.env.local')) {
    process.loadEnvFile('.env.local');
  }
}
