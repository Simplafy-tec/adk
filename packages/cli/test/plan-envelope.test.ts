/**
 * issue#2500 parte 5 — `adk plan` mostrava "atualizar" para TODO artefato,
 * inclusive quando o servidor dizia `noop`.
 *
 * As duas rotas do Hub respondem em formatos diferentes:
 *
 *   POST /adk/tools/apply -> { plan: {action, changes, ...}, applied: true }
 *   POST /adk/tools/plan  -> { slug, action, changes, ... }        <- plano CRU
 *
 * A CLI lia `resposta.plan ?? {}` nos dois casos, então no `plan` o objeto vinha
 * vazio, `action` ficava `null` e a impressão caía no rótulo de mudança. Efeito
 * medido em staging: depois de um deploy bem-sucedido, o `plan` seguinte
 * imprimia "atualizar" enquanto a API respondia
 * `{"action":"noop","changes":[],"drift":{"drifted":false}}` — o operador não
 * tinha como saber que já estava convergido.
 *
 * RED: `planoDaResposta` não existe.
 */
import { describe, expect, it } from 'vitest';
import { planoDaResposta } from '../src/hub.js';
import { linhasDoPlano, type LinhaRelatorio } from '../src/commands/deploy.js';

describe('planoDaResposta — as duas formas de resposta (issue#2500)', () => {
  it('lê o envelope do apply (`{plan, applied}`)', () => {
    const p = planoDaResposta({
      plan: { action: 'update', changes: [{ field: 'description', to: 'x' }] },
      applied: true,
    });

    expect(p.action).toBe('update');
    expect(p.changes).toHaveLength(1);
  });

  it('lê o plano CRU do plan (sem envelope) — o caso que quebrava', () => {
    const p = planoDaResposta({
      slug: 'soma-prototipo',
      action: 'noop',
      changes: [],
      drift: { drifted: false, fields: [] },
    });

    expect(p.action).toBe('noop');
  });

  it('envelope vazio não vira plano cru por engano', () => {
    // `{plan: {...}}` presente manda, mesmo que o topo tenha ruído.
    const p = planoDaResposta({ plan: { action: 'create', changes: [] }, action: 'noop' });

    expect(p.action).toBe('create');
  });

  it('resposta sem action nenhuma continua sem action (não inventa)', () => {
    expect(planoDaResposta({ applied: false }).action).toBeUndefined();
  });
});

// issue#2776 — o plano trazia `toolBindings` e a CLI não imprimia nada: o
// operador lia "sem alteração" e o deploy seguinte criava o vínculo. Remoção é
// o caso que precisa saltar aos olhos (incidente #1005: 17 vínculos apagados
// em produção).
describe('impressão do plano — vínculos de tool', () => {
  function linhaCom(
    toolBindings: { name: string; action: string }[],
    action = 'update',
    toolRevocations: LinhaRelatorio['toolRevocations'] = [],
  ): LinhaRelatorio {
    return {
      arquivo: 'demo-adk-assistente.yaml',
      org: 'demo-qa',
      kind: 'agent',
      slug: 'demo-adk-assistente',
      action,
      changes: [],
      collaborators: [],
      toolBindings,
      toolRevocations,
      blocking: [],
      pending: [],
      applied: false,
    };
  }

  it('vínculo criado aparece na saída', () => {
    const saida = linhasDoPlano('agentes/x.yaml', linhaCom([
      { name: 'demo_plugin_cep', action: 'create' },
    ])).join('\n');
    expect(saida).toContain('tool demo_plugin_cep: vincular');
    expect(saida).toContain('atualizar');
  });

  it('remoção aparece em destaque', () => {
    expect(
      linhasDoPlano('agentes/x.yaml', linhaCom([{ name: 'tool_antiga', action: 'remove' }])).join('\n'),
    ).toContain('tool tool_antiga: DESVINCULAR');
  });

  it('plano convergido segue dizendo "sem alteração"', () => {
    expect(linhasDoPlano('agentes/x.yaml', linhaCom([], 'noop')).join('\n')).toContain(
      'sem alteração',
    );
  });

  it('cada vínculo revogado por tools_remover vira uma linha própria "remover vínculo"', () => {
    const saida = linhasDoPlano(
      'agentes/x.yaml',
      linhaCom([], 'update', [
        { name: 'crm_delete_lead', action: 'remove' },
        { name: 'crm_merge_contacts', action: 'remove' },
      ]),
    );

    expect(saida.filter((l) => l.includes(': remover vínculo'))).toEqual([
      '      tool crm_delete_lead: remover vínculo',
      '      tool crm_merge_contacts: remover vínculo',
    ]);
  });

  it('revogação de integração mostra o nome declarado no arquivo, não o id interno', () => {
    const saida = linhasDoPlano(
      'agentes/x.yaml',
      linhaCom([], 'update', [{ name: 'cm2x9integracao0pipefy', declared: 'Pipefy', action: 'remove' }]),
    ).join('\n');

    expect(saida).toContain('tool Pipefy: remover vínculo');
    expect(saida).not.toContain('cm2x9integracao0pipefy');
  });

  it('revogação pendente impede o "sem alteração" mesmo com action noop no topo', () => {
    const saida = linhasDoPlano(
      'agentes/x.yaml',
      linhaCom([], 'noop', [{ name: 'crm_delete_lead', action: 'remove' }]),
    ).join('\n');

    expect(saida).not.toContain('sem alteração');
    expect(saida).toContain('tool crm_delete_lead: remover vínculo');
  });
});
