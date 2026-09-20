/**
 * Proactive optimization backlog.
 *
 * The findings side of this pipeline is reactive — it only ever acts on
 * failures that already happened in harness_agent_runs. This module is the
 * other half of "ops": a place to queue up *improvements* you want made to
 * the target repo (new features, refactors, hardening) that then flow through
 * the exact same "drive a coding agent -> open a PR -> record in the ledger"
 * machinery as an auto-diagnosed fix.
 *
 * A backlog item is a small JSON file (or an array of them) under the
 * configured optimizations directory. Each shipped optimization is recorded
 * in the remediation ledger by its signature so it isn't re-attempted on the
 * next run. Unlike a failure finding, an optimization never "recurs" — once
 * it's in the ledger it's considered done; bump its `id` (or add a new file)
 * to request further work.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Ledger } from './diagnose';

export const OptimizationSchema = z.object({
  /** Stable, unique slug — becomes part of the ledger signature. */
  id: z.string().min(1),
  /** One-line summary of the change. */
  title: z.string().min(1),
  /** Why this is worth doing — given to the agent as motivation/acceptance context. */
  rationale: z.string().min(1),
  /** Optional concrete implementation guidance / constraints. */
  details: z.string().optional(),
  /** Optional priority used only for ordering in reports and prompts. */
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type Optimization = z.infer<typeof OptimizationSchema>;

const FileSchema = z.union([OptimizationSchema, z.array(OptimizationSchema)]);

const PRIORITY_ORDER: Record<Optimization['priority'], number> = { high: 0, medium: 1, low: 2 };

export function optimizationSignature(opt: Pick<Optimization, 'id'>): string {
  return `opt::${opt.id}`;
}

/**
 * Load and validate every optimization defined under `dir`. Returns [] if the
 * directory doesn't exist (a backlog is optional). Throws on a malformed file
 * or a duplicate id, since silently dropping a requested change is worse than
 * failing loudly.
 */
export function loadOptimizations(dir: string): Optimization[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const optimizations: Optimization[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as unknown;
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid optimization file ${file}: ${parsed.error.message}`);
    }
    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    for (const item of items) {
      if (seen.has(item.id)) {
        throw new Error(`Duplicate optimization id "${item.id}" (in ${file})`);
      }
      seen.add(item.id);
      optimizations.push(item);
    }
  }

  return optimizations.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

/** Optimizations not yet shipped — i.e. whose signature isn't in the ledger. */
export function pendingOptimizations(optimizations: Optimization[], ledger: Ledger): Optimization[] {
  return optimizations.filter((opt) => !ledger[optimizationSignature(opt)]);
}
