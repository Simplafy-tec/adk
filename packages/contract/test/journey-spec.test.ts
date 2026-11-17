import { describe, expect, it } from 'vitest';
import { journeyFlowToGraph, statusInicialDaJornada, type JourneySpec } from '../src/index.js';

// Porte das partes PURAS de apps/api/src/adk/journey-plan.ts (hub-v2,
// origin/staging) — journeyFlowToGraph + statusInicialDaJornada — item 6 do
// brief de correção. Fixture SINTÉTICA (não a jornada real de um cliente): mesma
// forma do dialeto declarativo (wait/condition/send_template/exit), nomes
// genéricos.

const spec: JourneySpec = {
  spec_version: 'v1',
  kind: 'journey',
  slug: 'jornada-exemplo',
  definition: {
    name: 'Jornada de Exemplo',
    description: 'Fluxo sintético para teste de porte.',
    trigger: {
      type: 'stage_changed',
      pipeline: 'pipeline-exemplo',
      stage: 'fase-exemplo',
    },
    flow: [
      { id: 'aguardar', type: 'wait', duration_hours: 24, next: 'checar' },
      {
        id: 'checar',
        type: 'condition',
        expression: 'lead.concluiu != true',
        on_true: 'enviar',
        on_false: 'sair',
      },
      {
        id: 'enviar',
        type: 'send_template',
        template: 'template_exemplo_01',
        language: 'pt_BR',
        next: 'sair',
      },
      { id: 'sair', type: 'exit' },
    ],
  },
  overridable: { status: 'PAUSED' },
};

const porId = (nodes: ReturnType<typeof journeyFlowToGraph>['nodes'], id: string) =>
  nodes.find((n) => n.id === id);

describe('journeyFlowToGraph — flow declarativo → grafo do canvas', () => {
  const { nodes, edges } = journeyFlowToGraph(spec);

  it('cria o nó de entrada com a identidade do arquivo e os parâmetros do trigger no topo do data', () => {
    const entrada = porId(nodes, 'entrada');
    expect(entrada?.type).toBe('entrada');
    expect(entrada?.data.adkSlug).toBe('jornada-exemplo');
    expect(entrada?.data.pipeline).toBe('pipeline-exemplo');
    expect(entrada?.data.stage).toBe('fase-exemplo');
    // Defeito 1 (issue#2263 no hub-v2): nada de segunda cópia em data.trigger.
    expect(entrada?.data.trigger).toBeUndefined();
  });

  it('traduz cada tipo do dialeto para o tipo/executor do produto', () => {
    expect(porId(nodes, 'aguardar')).toMatchObject({
      type: 'wait',
      data: { executor: 'wait', delayMs: 24 * 3_600_000 },
    });
    expect(porId(nodes, 'checar')).toMatchObject({
      type: 'condition',
      data: { executor: 'condition', expression: 'lead.concluiu != true' },
    });
    expect(porId(nodes, 'enviar')).toMatchObject({
      type: 'send-whatsapp-template',
      data: {
        executor: 'send-whatsapp-template',
        templateName: 'template_exemplo_01',
        languageCode: 'pt_BR',
      },
    });
    expect(porId(nodes, 'sair')?.type).toBe('saida');
  });

  it('liga entrada → primeiro nó e traduz next/on_true/on_false em handles', () => {
    const aresta = (source: string, target: string) =>
      edges.find((e) => e.source === source && e.target === target);
    expect(aresta('entrada', 'aguardar')).toBeDefined();
    expect(aresta('aguardar', 'checar')?.sourceHandle).toBeUndefined();
    expect(aresta('checar', 'enviar')?.sourceHandle).toBe('true');
    expect(aresta('checar', 'sair')?.sourceHandle).toBe('false');
  });

  it('o mapeamento é determinístico: mesmo arquivo, mesmo grafo', () => {
    expect(journeyFlowToGraph(spec)).toEqual({ nodes, edges });
  });
});

describe('statusInicialDaJornada — jornada aplicada nunca nasce ativa', () => {
  it('o spec declara PAUSED e é isso que a criação usa', () => {
    expect(statusInicialDaJornada(spec)).toBe('PAUSED');
  });

  it('sem declaração cai no default do produto (DRAFT)', () => {
    expect(statusInicialDaJornada({ ...spec, overridable: {} })).toBe('DRAFT');
  });

  it('ACTIVE não tem tradução — degrada para DRAFT, nunca para ativo', () => {
    expect(statusInicialDaJornada({ ...spec, overridable: { status: 'ACTIVE' } })).toBe('DRAFT');
  });
});
