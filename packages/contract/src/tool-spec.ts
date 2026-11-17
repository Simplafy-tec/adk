/**
 * ADK — forma declarativa da tool (kind: tool).
 *
 * Partes PURAS de `apps/api/src/adk/tool-plan.ts` (hub-v2, origin/staging): o
 * tipo do spec e a tradução spec → contrato do registro. O diff contra a linha
 * gravada (`planToolApply`) fica no servidor, que é quem tem a linha.
 */

import { z } from 'zod';

/** Forma declarativa da tool no repositório de clientes. */
export interface ToolSpec {
  spec_version: string;
  kind: 'tool';
  slug: string;
  definition: {
    /** Nome runtime da tool (snake_case) — o que o LLM enxerga. */
    name: string;
    display_name?: string;
    /** A descrição É o contrato para o modelo decidir acionar. */
    description: string;
    /** Kind interno do registro: native | integration | journey | openapi | mcp. */
    kind: string;
    scope?: string;
    input_schema: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  };
  /** Slugs de Connection da organização que a execução consome. */
  connections?: string[];
}

export const ToolSpecSchema = z.object({
  spec_version: z.string(),
  kind: z.literal('tool'),
  slug: z.string().min(1),
  definition: z
    .object({
      name: z.string(),
      display_name: z.string().optional(),
      description: z.string(),
      kind: z.string(),
      scope: z.string().optional(),
      input_schema: z.record(z.unknown()),
      output_schema: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  connections: z.array(z.string()).optional(),
});

/**
 * O contrato CRU (forma minúscula do Zod) que o apply entrega ao `gravarTool`.
 *
 * `origin: 'adk'`, `scope: 'org'` e o `orgId` do ALVO são fixados aqui — nunca
 * lidos do arquivo: quem escreve o repositório de clientes não escolhe tenant
 * nem escopo, mesmo contrato da organização na query do controller.
 */
export function toolContractFromSpec(spec: ToolSpec, orgId: string): Record<string, unknown> {
  const d = spec.definition;
  return {
    name: d.name,
    displayName: d.display_name ?? d.name,
    description: d.description,
    kind: d.kind,
    inputSchema: d.input_schema,
    ...(d.output_schema !== undefined ? { outputSchema: d.output_schema } : {}),
    origin: 'adk',
    scope: 'org',
    orgId,
    status: 'live',
    version: 1,
  };
}
