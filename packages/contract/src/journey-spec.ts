/**
 * ADK — forma declarativa da jornada (kind: journey).
 *
 * Partes PURAS de `apps/api/src/adk/journey-plan.ts` (hub-v2, origin/staging):
 * o dialeto declarativo do arquivo, a allowlist de `references:`, a tradução
 * para o grafo do canvas (`journeyFlowToGraph`) e o status inicial
 * (`statusInicialDaJornada`). O que ficou no servidor é só o que toca o banco
 * (diff contra a linha atual e resolução de referências no destino).
 */

import { z } from 'zod';
import { toSlug } from './reference-resolver.js';

/** Nó do dialeto declarativo do arquivo. */
export interface JourneyFlowNode {
  id: string;
  type: string;
  next?: string;
  on_true?: string;
  on_false?: string;
  /** Endereço legível -> id do recurso, resolvido no destino (issue#2263). */
  references?: Record<string, string>;
  /** Escape hatch: mesclado no `data` do nó VERBATIM (defeito 3). */
  params?: Record<string, unknown>;
  [param: string]: unknown;
}

export interface JourneySpec {
  spec_version: string;
  kind: 'journey';
  slug: string;
  definition: {
    name: string;
    description?: string;
    trigger: {
      type: string;
      /** Mesma semântica de `JourneyFlowNode.references` (issue#2263). */
      references?: Record<string, string>;
      [param: string]: unknown;
    };
    flow: JourneyFlowNode[];
    /**
     * "Como chamar quem não tem nome": a palavra que as mensagens usam quando o contato não tem nome. Ausente, o apply
     * não mexe no valor (jornada nova nasce com o default do Hub, `cliente`).
     */
    fallbackContactName?: string;
  };
  overridable?: { status?: string };
}

/** Mesma régua do Hub (DTO da jornada): texto aparado de 1 a 60 caracteres. */
export const FALLBACK_CONTACT_NAME_MAX = 60;

export const JourneySpecSchema = z.object({
  spec_version: z.string(),
  kind: z.literal('journey'),
  slug: z.string().min(1),
  definition: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      trigger: z.object({ type: z.string() }).passthrough(),
      flow: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
      fallbackContactName: z
        .string()
        .trim()
        .min(1)
        .max(FALLBACK_CONTACT_NAME_MAX)
        .optional()
        .describe(
          'Como chamar quem não tem nome: a palavra que as mensagens usam quando o contato não tem nome ' +
            '(ex.: "Oi, produtor!"). Texto de 1 a 60 caracteres, aparado; vazio é recusado. Ausente, o apply ' +
            'não mexe no valor: jornada nova nasce com "cliente" e a existente mantém o que tem.',
        ),
    })
    .passthrough(),
  overridable: z.object({ status: z.string().optional() }).passthrough().optional(),
});

/**
 * Chaves de `references:` aceitas e o recurso que cada uma endereça
 * (issue#2263). Reusado pelo portão de estrutura (chave desconhecida é
 * bloqueio) e pela resolução no servidor (universo por kind).
 */
export const REFERENCE_FIELD_KIND: Readonly<
  Record<string, 'channel' | 'integration' | 'pipeline' | 'pipelineStage' | 'webhook' | 'agent'>
> = {
  channelId: 'channel',
  integrationId: 'integration',
  pipelineId: 'pipeline',
  pipelineStageId: 'pipelineStage',
  stageId: 'pipelineStage',
  fromStageId: 'pipelineStage',
  toStageId: 'pipelineStage',
  webhookId: 'webhook',
  agentId: 'agent',
};

/** Par de exibição (id -> nome) que o contrato do nó reconhece. */
const REFERENCE_NAME_PAIR: Readonly<Record<string, string>> = {
  webhookId: 'webhookName',
  integrationId: 'integrationName',
  agentId: 'agentName',
};

/**
 * Uma referência de jornada JÁ resolvida: o id do recurso e, quando existe par
 * de exibição, o nome. Nome distinto do `ResolvedReference` do
 * `reference-resolver` de propósito — aquele é o RESULTADO da busca (com
 * `status`), este é o que o grafo consome depois de resolvida.
 */
export interface ResolvedJourneyReference {
  id: string;
  name?: string;
}

/** Referências resolvidas de UM bloco (`trigger` ou um nó do `flow`), por campo. */
export type ResolvedNodeReferences = Record<string, ResolvedJourneyReference>;

/**
 * Todas as referências resolvidas de uma jornada, por endereço de bloco:
 * `'trigger'` para `definition.trigger.references`, ou o `id` do nó para
 * `definition.flow[i].references`.
 */
export type ResolvedReferences = Record<string, ResolvedNodeReferences>;

function overlayResolved(bloco: ResolvedNodeReferences | undefined): Record<string, unknown> {
  if (!bloco) return {};
  const out: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(bloco)) {
    out[campo] = valor.id;
    const nomeCampo = REFERENCE_NAME_PAIR[campo];
    if (nomeCampo && valor.name) out[nomeCampo] = valor.name;
  }
  return out;
}

/** Nó/aresta na forma do canvas (o que `Journey.nodes`/`edges` persistem). */
export interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

/**
 * Gatilho declarado → `kind` do nó de entrada do canvas. Tipo desconhecido
 * atravessa cru: o portão é estrito em estrutura e permissivo em parâmetro, e o
 * engine acha a entrada por `type`, não por `kind`.
 */
const TRIGGER_TYPE_TO_ENTRY_KIND: Record<string, string> = {
  stage_changed: 'crm-pipeline',
  first_contact: 'first-contact',
  cron: 'cron',
  webhook: 'webhook',
};

/**
 * Parâmetros do nó: tudo menos identidade, arestas e os blocos reservados
 * `references:`/`params:`. `params:` é o escape hatch para um parâmetro cujo
 * nome colide com uma chave do dialeto — mesclado por cima VERBATIM.
 */
function paramsDe(no: JourneyFlowNode): Record<string, unknown> {
  const {
    id: _id,
    type: _type,
    next: _next,
    on_true: _t,
    on_false: _f,
    references: _refs,
    params: escape,
    ...resto
  } = no;
  return { ...resto, ...(escape ?? {}) };
}

/**
 * Tipo de nó do dialeto → tipo + data do canvas. Só os tipos com casa própria
 * no produto são traduzidos; tipo desconhecido atravessa com os parâmetros
 * crus (a jornada nasce pausada — quem completa a configuração é o operador).
 */
function mapFlowNode(no: JourneyFlowNode): { type: string; data: Record<string, unknown> } {
  const params = paramsDe(no);
  switch (no.type) {
    case 'wait': {
      const horas = typeof no.duration_hours === 'number' ? no.duration_hours : null;
      const { duration_hours: _horas, ...resto } = params;
      return {
        type: 'wait',
        data: {
          executor: 'wait',
          ...(horas !== null ? { delayMs: horas * 3_600_000 } : {}),
          ...resto,
        },
      };
    }
    case 'condition':
      return { type: 'condition', data: { executor: 'condition', ...params } };
    case 'send_template': {
      const { template, language, ...resto } = params;
      return {
        type: 'send-whatsapp-template',
        data: {
          executor: 'send-whatsapp-template',
          ...(typeof template === 'string' ? { templateName: template } : {}),
          ...(typeof language === 'string' ? { languageCode: language } : {}),
          ...resto,
        },
      };
    }
    case 'exit':
      // `saida` é o tipo que o produto conhece (→ executor journey-exit);
      // encerra por não ter aresta de saída.
      return { type: 'saida', data: params };
    default:
      return { type: no.type, data: params };
  }
}

/**
 * Campos do gatilho `cron` que o scheduler lê na raiz de `data`. `cron` no
 * arquivo vira `cronExpr` no canvas (nome que o motor espera).
 */
function promoteCronTriggerFields(
  trigger: { type: string; [param: string]: unknown } | undefined,
): Record<string, unknown> {
  if (!trigger || trigger.type !== 'cron') return {};
  const out: Record<string, unknown> = {};
  const cron = trigger['cron'] ?? trigger['cronExpr'];
  if (typeof cron === 'string' && cron.trim()) out.cronExpr = cron.trim();
  if (typeof trigger['agentId'] === 'string' && (trigger['agentId'] as string).trim()) {
    out.agentId = (trigger['agentId'] as string).trim();
  }
  if (typeof trigger['idleThresholdDays'] === 'number') {
    out.idleThresholdDays = trigger['idleThresholdDays'];
  }
  if (trigger['select'] && typeof trigger['select'] === 'object') out.select = trigger['select'];
  return out;
}

/**
 * O grafo do canvas como o apply o gravaria.
 *
 * O nó `entrada` carrega DUAS coisas além do gatilho: o `kind` que o painel do
 * editor usa, e `adkSlug` — a identidade do arquivo dentro do grafo. É por
 * `adkSlug` que o próximo apply reencontra ESTA jornada (o slug do arquivo não
 * deriva do nome de exibição, então casar por nome não basta).
 *
 * Posições são determinísticas: mesmo arquivo ⇒ mesmo grafo, byte a byte — é o
 * que faz o reapply comparar igual e virar noop.
 */
export function journeyFlowToGraph(
  spec: JourneySpec,
  resolved: ResolvedReferences = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const trigger = spec.definition.trigger;
  // Os parâmetros do `trigger:` aterrissam no TOPO do `data` do nó de entrada —
  // é onde os consumidores reais leem. Nada de `data.trigger` como segunda
  // cópia: histórico inerte, ninguém lê.
  const { type: _triggerType, references: _triggerRefs, ...triggerParams } = trigger ?? {};
  const nodes: CanvasNode[] = [
    {
      id: 'entrada',
      type: 'entrada',
      position: { x: 40, y: 80 },
      data: {
        kind: TRIGGER_TYPE_TO_ENTRY_KIND[trigger?.type ?? ''] ?? trigger?.type ?? '',
        adkSlug: toSlug(spec.slug),
        ...triggerParams,
        ...promoteCronTriggerFields(trigger),
        ...overlayResolved(resolved.trigger),
      },
    },
  ];
  const edges: CanvasEdge[] = [];

  const flow = spec.definition.flow ?? [];
  flow.forEach((no, i) => {
    const mapeado = mapFlowNode(no);
    nodes.push({
      id: no.id,
      type: mapeado.type,
      position: { x: 40 + (i + 1) * 280, y: 80 },
      data: { ...mapeado.data, ...overlayResolved(resolved[no.id]) },
    });
  });

  const primeiro = flow[0];
  if (primeiro) {
    edges.push({ id: `e-entrada-${primeiro.id}`, source: 'entrada', target: primeiro.id });
  }
  for (const no of flow) {
    // `sourceHandle` omitido = handle 'out' (default do engine); condição usa
    // os handles 'true'/'false' que o runner devolve.
    if (typeof no.next === 'string') {
      edges.push({ id: `e-${no.id}-${no.next}`, source: no.id, target: no.next });
    }
    if (typeof no.on_true === 'string') {
      edges.push({
        id: `e-${no.id}-true-${no.on_true}`,
        source: no.id,
        target: no.on_true,
        sourceHandle: 'true',
      });
    }
    if (typeof no.on_false === 'string') {
      edges.push({
        id: `e-${no.id}-false-${no.on_false}`,
        source: no.id,
        target: no.on_false,
        sourceHandle: 'false',
      });
    }
  }

  return { nodes, edges };
}

/**
 * Status inicial de uma jornada CRIADA pelo apply. Só DRAFT/PAUSED existem
 * neste mapa — 'ACTIVE' não tem tradução de propósito: além do portão que o
 * recusa, um spec que chegue aqui por outra porta degrada para DRAFT (o
 * default do produto), nunca para ativo.
 */
export function statusInicialDaJornada(spec: JourneySpec): 'DRAFT' | 'PAUSED' {
  return spec.overridable?.status === 'PAUSED' ? 'PAUSED' : 'DRAFT';
}
