/**
 * Política da plataforma — o que `GET /api/v1/adk/policy` devolve (ADR-120 §3).
 *
 * O endpoint chega no Hub na parte 2 desta fatia; até lá (e sempre que o Hub
 * estiver fora do ar) a CLI cai para `DEFAULT_POLICY`, que é a MESMA tabela de
 * valores. Deixar o `doctor` mudo por indisponibilidade do produto seria trocar
 * um diagnóstico por um silêncio.
 */

import { z } from 'zod';
import type { SpecIssue } from './spec-gates.js';
import { SUPPORTED_SPEC_VERSIONS } from './spec-gates.js';
import { checkUiAdherence, type ArquivoUi } from './ui-adherence.js';

export const PolicySchema = z.object({
  spec_versions: z.array(z.string()).min(1),
  runtimes: z.object({
    node: z.string(),
    python: z.array(z.string()),
    uv: z.string(),
  }),
  /**
   * Teto por classe de runtime. `script` é preenchido (N5, mesmo valor de
   * `LIMITES_SCRIPT` do hub-v2); `mcp`/`app`/`org`/`node` seguem vazios na
   * política embutida — o Hub anuncia os dele em `GET /api/v1/adk/policy`.
   */
  limits: z.record(z.record(z.number())),
  registries: z.object({ allowed_images: z.array(z.string()) }),
  package: z.object({ max_size_bytes: z.number().int().positive() }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  spec_versions: [...SUPPORTED_SPEC_VERSIONS],
  runtimes: { node: '>=20', python: ['3.12'], uv: '>=0.4' },
  limits: { script: { cpu: 1, memory: 512, timeout: 60 }, mcp: {}, app: {}, org: {}, node: {} },
  registries: { allowed_images: [] },
  package: { max_size_bytes: 5_000_000 },
};

export interface PolicyCheckInput {
  kind: string;
  /** Tamanho do que seria publicado, em bytes. */
  packageSizeBytes?: number;
  /**
   * Texto dos arquivos do pacote. Só `kind: app` usa — é a entrada do lint de
   * aderência, que precisa do CONTEÚDO e não só do tamanho.
   */
  files?: readonly ArquivoUi[];
}

/**
 * Confere o pacote contra a política: tamanho e, para `kind: app`, aderência ao
 * design system. Runtime é conferido pelo `doctor` (que enxerga a máquina) e os
 * `limits` da tool por `checkScriptLimits`.
 */
export function checkAgainstPolicy(input: PolicyCheckInput, policy: Policy): SpecIssue[] {
  const issues: SpecIssue[] = [];

  const teto = policy.package.max_size_bytes;
  if (input.packageSizeBytes !== undefined && input.packageSizeBytes > teto) {
    issues.push({
      code: 'package_too_large',
      path: '',
      message: `Pacote com ${input.packageSizeBytes} bytes excede o limite da plataforma (${teto}).`,
    });
  }

  // Aderência ao design system só vale para `kind: app` — é o único artefato
  // que renderiza tela. Rodar em tool/mcp acusaria `#` de comentário Python
  // como cor literal.
  if (input.kind === 'app' && input.files) {
    issues.push(...checkUiAdherence(input.files));
  }

  return issues;
}

/**
 * Campos de `limits:` fora do teto da classe — mesma regra de
 * `limitesForaDoTeto` do apply do Hub (hub-v2 `adk-policy.ts`). Recusa valor
 * acima do teto, chave que a classe não conhece, valor não numérico e `<= 0`:
 * no executor, `timeout: 0` significa SEM teto.
 */
export function limitsOutsideBudget(
  limits: unknown,
  budget: Readonly<Record<string, number>>,
): string[] {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return ['limits'];
  return Object.entries(limits as Record<string, unknown>)
    .filter(([field, value]) => {
      const max = budget[field];
      if (max === undefined) return true;
      return typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max;
    })
    .map(([field]) => field);
}

/**
 * Portão de `limits` para tool `runtime: script` — o MESMO código e path que o
 * apply devolve (`limits_over_budget` em `definition.limits`). O teto vem da
 * política recebida (a do Hub ou a embutida), nunca de constante local.
 * `limits` ausente não é julgado aqui (o apply recusa com `limits_missing`).
 */
export function checkScriptLimits(definition: unknown, policy: Policy): SpecIssue[] {
  if (definition === null || typeof definition !== 'object') return [];
  const { runtime, limits } = definition as { runtime?: unknown; limits?: unknown };
  if (runtime !== 'script' || limits === undefined) return [];

  const budget = policy.limits.script ?? {};
  const outside = limitsOutsideBudget(limits, budget);
  if (outside.length === 0) return [];

  const teto = Object.entries(budget)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    {
      code: 'limits_over_budget',
      path: 'definition.limits',
      message: `Limites fora da classe script (${outside.join(', ')}) — teto: ${teto}.`,
    },
  ];
}
