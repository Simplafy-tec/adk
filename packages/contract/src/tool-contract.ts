/**
 * Registro de contratos — contrato Zod da entidade Tool.
 *
 * Porte fiel de `apps/api/src/tool-registry/tool-contract.ts` (hub-v2,
 * origin/staging). É a dependência do portão 1 de `kind: tool`: o que o Zod
 * recusaria NA GRAVAÇÃO é o que `validateToolSpecStructure` recusa no arquivo.
 */
import { z } from 'zod';

/** JSON Schema mínimo de objeto — contrato de input/output das tools. */
export const JsonSchemaObjeto = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.unknown()).default({}),
    required: z.array(z.string()).optional(),
  })
  .passthrough();
export type JsonSchemaObjeto = z.infer<typeof JsonSchemaObjeto>;

/** JSON Schema de SAÍDA — mais permissivo que o de entrada (hub#2.6.20.3). */
export const JsonSchemaSaida = z.object({ type: z.string().min(1) }).passthrough();
export type JsonSchemaSaida = z.infer<typeof JsonSchemaSaida>;

/** Nome de tool: 3–64 chars, snake_case iniciando por letra. */
export const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;

export const TOOL_KINDS = ['native', 'journey', 'integration', 'openapi', 'mcp'] as const;
export const TOOL_ORIGINS = ['system', 'org', 'adk'] as const;
export const TOOL_SCOPES = ['global', 'org'] as const;
export const TOOL_STATUSES = ['draft', 'live'] as const;

export const ToolContract = z
  .object({
    name: z.string().regex(TOOL_NAME_REGEX, 'nome deve ser snake_case, 3-64 chars'),
    displayName: z.string().min(1),
    /** min 20: a descrição é a interface pro LLM — descrição rasa = tool nunca chamada. */
    description: z.string().min(20),
    kind: z.enum(TOOL_KINDS),
    inputSchema: JsonSchemaObjeto,
    outputSchema: JsonSchemaSaida.optional(),
    origin: z.enum(TOOL_ORIGINS),
    scope: z.enum(TOOL_SCOPES),
    orgId: z.string().min(1).optional(),
    status: z.enum(TOOL_STATUSES),
    version: z.number().int().min(1),
    /** Nome da tool que substitui esta (deprecação sem breaking). */
    deprecatedBy: z.string().regex(TOOL_NAME_REGEX).optional(),
    connectionSlug: z.string().optional(),
    serverSlug: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'org' && !v.orgId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgId'],
        message: "orgId é obrigatório quando scope='org'",
      });
    }
    if (v.kind === 'mcp' && !v.serverSlug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serverSlug'],
        message: "serverSlug é obrigatório quando kind='mcp'",
      });
    }
  });
export type ToolContract = z.infer<typeof ToolContract>;
