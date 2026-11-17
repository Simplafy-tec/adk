/**
 * `adk validate | plan | deploy` — o ciclo do repositório de clientes.
 *
 * `validate` roda OFFLINE (mesmo motor do servidor, via `adk-contract`);
 * `plan` e `deploy` falam com o Hub. Diferença deliberada em relação à CLI
 * antiga: um artefato que falha NÃO aborta os demais. O deploy de um cliente
 * com 20 arquivos não pode parar no terceiro e deixar metade da configuração
 * aplicada sem relatório — o exit code continua 1, mas depois de tentar tudo.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseSpecYaml,
  scanLeaks,
  validateSpecStructureAs,
  type SpecIssue,
} from '@simpla.fy/adk-contract';
import {
  artefatosDaOrg,
  listarArtefatos,
  listarOrgs,
  listarYamlsExtras,
  promptDe,
  type Artefato,
} from '../artefatos.js';
import { injetarPacoteNoSpec, montarBundle, type Bundle } from '../bundle.js';
import {
  camposComEcoDeclarados,
  camposSemEco,
  mensagemSemSuporte,
  type CampoComEco,
} from '../eco-do-plano.js';
import {
  planoDaResposta,
  chamarAdk,
  type ApplyResult,
  type Plano,
  type RevogacaoDoPlano,
  type VinculoDoPlano,
} from '../hub.js';
import { pacotesDeTime, validarTimes } from '../time.js';
import { checarOrgYaml } from '../org-config.js';
import { resolverAmbiente, type Ctx } from '../ctx.js';
import { pastaDaOrg } from './export.js';
import { perguntar, temTerminal } from '../pergunta.js';

export interface OpcoesDeploy {
  org?: string;
  /** Sem `--env`, vale o ambiente do perfil (ver `resolverAmbiente`). */
  env?: string;
  dir?: string;
  json?: boolean;
  /** Pula a confirmação de apply em produção (CI, agente). */
  yes?: boolean;
}

/** Uma linha do relatório `--json`. `blocking` aceita o código cru do servidor. */
export interface LinhaRelatorio {
  arquivo: string;
  org: string;
  kind: string;
  slug: string | null;
  action: string | null;
  changes: { field: string; from?: unknown; to?: unknown }[];
  collaborators: { agent: string; action: string }[];
  /** Vínculos agente↔tool que o apply vai criar, alterar ou REMOVER. */
  toolBindings: VinculoDoPlano[];
  /** Vínculos que o apply vai APAGAR por `tools_remover` (o `noop` não entra). */
  toolRevocations: RevogacaoDoPlano[];
  /** Áreas do Agent Control que o apply vai gravar (ausente = nada muda nelas). */
  agentControl?: Plano['agentControl'];
  blocking: { code: string; path: string; message: string }[];
  pending: { field: string; slug: string; reason: string }[];
  applied: boolean;
}

function slugDe(artefato: Artefato): string | null {
  const slug = (parseSpecYaml(artefato.yaml) as { slug?: unknown }).slug;
  return typeof slug === 'string' ? slug : null;
}

export async function comandoValidate(
  ctx: Ctx,
  opcoes: { dir?: string; json?: boolean; org?: string; env?: string },
): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  // `--org <id>` restringe a validação à pasta da organização (o mesmo id que `plan`/`apply` recebem). Local: não fala com o Hub.
  let soPasta: string | null = null;
  if (opcoes.org) {
    const resolvido = resolverAmbiente(ctx, opcoes.env, 'staging');
    if (!resolvido.ok) {
      ctx.err(resolvido.erro);
      return 2;
    }
    soPasta = pastaDaOrg(raiz, opcoes.org, resolvido.ambiente);
    if (!soPasta) {
      ctx.err(
        `Nenhuma pasta de organização declara "${opcoes.org}" em environments.${resolvido.ambiente}. ` +
          'Confira o id (e o perfil) ou o `orgs/<pasta>/org.yaml`.',
      );
      return 2;
    }
  }
  // Pasta de time (ADR-290): `team.yaml` na raiz, ou uma pasta de pacotes (o catálogo do Hub). Repositório de clientes (`orgs/`) tem
  // precedência: um `x/team.yaml` perdido ali não pode fazer o comando pular as orgs e sair com exit 0.
  const times = existsSync(join(raiz, 'orgs')) ? [] : pacotesDeTime(raiz);
  if (times.length > 0) return validarTimes(ctx, times, opcoes.json === true);
  const artefatos = listarArtefatos(raiz).filter((a) => soPasta === null || a.org === soPasta);
  if (artefatos.length === 0) {
    ctx.err(
      `Não encontrei "orgs/" em ${raiz}. Rode dentro do repositório de clientes, ou use --dir.`,
    );
    return 2;
  }

  const relatorio: { arquivo: string; org: string; kind: string; issues: SpecIssue[] }[] = [];

  // Cobertura igual à do `scripts/validar.mjs`, que este comando substitui: a
  // amarração de tenant de cada pasta, os specs, e o portão de vazamento sobre
  // TODO yaml da organização (`vinculos/` inclusive) — não só sobre os specs.
  for (const org of listarOrgs(raiz).filter((o) => soPasta === null || o === soPasta)) {
    const issues = checarOrgYaml(raiz, org);
    if (issues.length > 0) relatorio.push({ arquivo: 'org.yaml', org, kind: 'org', issues });
  }

  for (const a of artefatos) {
    const issues = [
      // O kind ESPERADO é o da pasta: `tools/` com `kind: journey` aplicaria o
      // artefato na porta errada, e o portão nomeia isso com `kind_mismatch`.
      ...validateSpecStructureAs(a.kind, parseSpecYaml(a.yaml)),
      ...scanLeaks(a.yaml, { filename: `orgs/${a.org}/${a.pasta}/${a.arquivo}` }),
    ];
    relatorio.push({ arquivo: a.arquivo, org: a.org, kind: a.kind, issues });
  }

  for (const extra of listarYamlsExtras(raiz).filter((x) => soPasta === null || x.org === soPasta)) {
    const issues = scanLeaks(extra.texto, { filename: extra.rel });
    if (issues.length > 0) {
      relatorio.push({
        arquivo: extra.rel.split('/').slice(2).join('/'),
        org: extra.org,
        kind: 'outro',
        issues,
      });
    }
  }

  const comProblema = relatorio.filter((r) => r.issues.length > 0);
  if (opcoes.json) {
    ctx.out(JSON.stringify({ artefatos: relatorio }, null, 2));
  } else {
    for (const r of relatorio) {
      const alvo = `${r.org}/${r.kind}/${r.arquivo}`;
      if (r.issues.length === 0) {
        ctx.out(`  ✓ ${alvo}`);
        continue;
      }
      ctx.out(`  ✗ ${alvo}`);
      for (const i of r.issues) ctx.out(`      ${i.code} ${i.path}: ${i.message}`);
    }
    ctx.out(`\n${relatorio.length} artefato(s), ${comProblema.length} com problema.`);
  }
  return comProblema.length > 0 ? 1 : 0;
}

export async function comandoPlanOuDeploy(
  ctx: Ctx,
  operacao: 'plan' | 'apply',
  opcoes: OpcoesDeploy,
): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const org = opcoes.org;
  if (!org) {
    ctx.err('Informe --org <id da organização>.');
    return 2;
  }
  // Ambiente que contradiz o perfil é pré-condição da RODADA inteira, não de
  // um artefato: checar aqui, ao lado do guard de `--org`, dá UMA linha só, com
  // o exit code de pré-condição, e nada chega ao Hub.
  const resolvido = resolverAmbiente(ctx, opcoes.env);
  if (!resolvido.ok) {
    ctx.err(resolvido.erro);
    return 2;
  }
  const { ambiente } = resolvido;

  // Só entram as pastas cujo `org.yaml` declara ESTE identificador no ambiente.
  const doOrg = artefatosDaOrg(raiz, org, ambiente);

  if (doOrg.length === 0) {
    ctx.err(
      `Nenhuma pasta de organização declara "${org}" no ambiente "${ambiente}".\n` +
        `Confira o campo environments.${ambiente} nos arquivos orgs/*/org.yaml.`,
    );
    return 1;
  }

  if (operacao === 'apply' && ambiente === 'production' && !opcoes.yes) {
    const confirmado = await confirmarProducao(ctx, org, doOrg);
    if (confirmado !== 0) return confirmado;
  }

  const relatorio: LinhaRelatorio[] = [];
  if (!opcoes.json) {
    ctx.out(`${operacao === 'plan' ? 'Plano' : 'Aplicando'} para a organização ${org}:\n`);
  }

  for (const a of doOrg) {
    const linha: LinhaRelatorio = {
      arquivo: a.arquivo,
      org: a.org,
      kind: a.kind,
      slug: slugDe(a),
      action: null,
      changes: [],
      collaborators: [],
      toolBindings: [],
      toolRevocations: [],
      blocking: [],
      pending: [],
      applied: false,
    };
    relatorio.push(linha);

    let resposta: ApplyResult;
    try {
      // O prompt (só existe em agente) é lido nos dois comandos — plan com
      // prompt_file quebrado tem de falhar aqui, antes de o operador acreditar
      // num plano que o apply não conseguiria executar. Só o apply o envia.
      const doPrompt = a.kind === 'agent' ? promptDe(a) : { prompt: undefined, issues: [] };
      if (doPrompt.issues.length > 0) {
        // Prompt fora do repositório ou com segredo NÃO vai ao Hub: o corpo do
        // apply carregaria o arquivo lido do disco do operador.
        linha.blocking.push(...doPrompt.issues);
        if (!opcoes.json) imprimirPlano(ctx, `${a.org}/${a.pasta}/${a.arquivo}`, linha);
        continue;
      }
      const prompt = doPrompt.prompt;
      // issue#2500 — tool de script só executa se o PACOTE chegar junto: o
      // `apply` cria a linha com `entry`/`handler`, mas sem `bundle` o worker
      // não tem código para rodar.
      //
      // O pacote é montado NOS DOIS comandos, não só no apply: o `bundleHash`
      // entra no diff do servidor, então um `plan` sem hash compara "undefined"
      // contra o hash gravado e devolve `atualizar` para sempre — o `adk plan`
      // NUNCA convergiria para noop depois de um deploy bem-sucedido (medido
      // em staging). O que muda entre os dois é só o ENVIO dos arquivos.
      let bundle: Bundle | undefined;
      if (a.dirPacote && /(^|\n)\s*runtime:\s*script\b/.test(a.yaml)) {
        try {
          bundle = montarBundle(a.dirPacote);
        } catch (e) {
          linha.blocking.push({
            code: 'bundle_invalido',
            path: a.arquivo,
            message: (e as Error).message,
          });
          if (!opcoes.json) imprimirPlano(ctx, `${a.org}/${a.pasta}/${a.arquivo}`, linha);
          continue;
        }
      }
      const yamlDoHub = bundle ? injetarPacoteNoSpec(a.yaml, bundle) : a.yaml;
      // O apply de um arquivo com Alcance/Agent Control só sai depois de o
      // plano provar que o Hub entende esses campos: um Hub antigo os ignoraria
      // e responderia "aplicado" sem gravar nada.
      if (operacao === 'apply' && camposComEcoDeclarados(a.yaml).length > 0) {
        const previa = planoDaResposta(
          await chamarAdk(ctx, { rota: a.rota, operacao: 'plan', orgId: org, yaml: yamlDoHub }),
        );
        const semEco = camposSemEco(a.yaml, previa);
        if (semEco.length > 0) {
          linha.blocking.push(...bloqueiosSemSuporte(semEco));
          if (!opcoes.json) imprimirPlano(ctx, `${a.org}/${a.pasta}/${a.arquivo}`, linha);
          continue;
        }
      }
      resposta = await chamarAdk(ctx, {
        rota: a.rota,
        operacao,
        orgId: org,
        // Com pacote, o spec que vai ao Hub declara `hash`/`lock` do conteúdo
        // REAL do disco — é contra esse hash que o servidor confere o bundle.
        yaml: yamlDoHub,
        prompt: operacao === 'apply' ? prompt : undefined,
        // Só o apply transporta os arquivos. No plan o servidor confere o hash
        // contra o blob já gravado — não precisa do código de novo.
        bundle: operacao === 'apply' ? bundle : undefined,
      });
    } catch (e) {
      // Falha de rede/credencial é DESTE artefato no relatório, e a rodada
      // continua: um 500 no meio da lista não pode esconder o estado dos outros.
      linha.blocking.push({ code: 'hub_error', path: a.arquivo, message: (e as Error).message });
      if (!opcoes.json) ctx.out(`  ✗ ${a.org}/${a.pasta}/${a.arquivo}: ${(e as Error).message}`);
      continue;
    }

    const plano = planoDaResposta(resposta);
    linha.action = plano.action ?? null;
    linha.changes = [...(plano.changes ?? [])];
    linha.collaborators = [...(plano.collaborators ?? [])];
    // Vínculo que o ADK não gerencia (`unmanaged`) e vínculo convergido
    // (`noop`) não são mudança — listá-los faria todo plano parecer sujo.
    linha.toolBindings = (plano.toolBindings ?? []).filter(
      (b) => b.action === 'create' || b.action === 'update' || b.action === 'remove',
    );
    // Remover o que já não existe é `noop`: é o que faz o plano convergir, e
    // não é mudança a mostrar.
    linha.toolRevocations = (plano.toolRevocations ?? []).filter((r) => r.action === 'remove');
    if (plano.agentControl && plano.agentControl.action !== 'noop') {
      // Áreas `none` não entram no `to`: um agente novo que só desliga áreas
      // chega como `create` com `{}` → `{}`, e isso não é mudança a mostrar.
      // Num agente existente o Hub cria a linha do Agent Control, então ecoa.
      const agenteNovoSemAreas =
        plano.action === 'create' &&
        mesmasAreas(plano.agentControl.from ?? {}, plano.agentControl.to);
      if (!agenteNovoSemAreas) {
        linha.agentControl = plano.agentControl;
      }
    }
    linha.blocking = [
      ...(plano.blocking ?? []),
      ...bloqueiosSemSuporte(camposSemEco(a.yaml, plano)),
    ];
    linha.pending = [...(plano.pending ?? [])];
    linha.applied = resposta.applied === true;
    if (resposta.error) {
      // Erro de execução chega FORA do plano — o plano estava limpo, a escrita
      // é que falhou no meio.
      linha.blocking.push({
        code: 'apply_error',
        path: resposta.error.path ?? '',
        message: resposta.error.message,
      });
    }
    if (!opcoes.json) imprimirPlano(ctx, `${a.org}/${a.pasta}/${a.arquivo}`, linha);
  }

  const { bloqueados, pendentes, aplicados, aplicadosComPendencia } =
    contagemDoRelatorio(relatorio);
  if (opcoes.json) {
    ctx.out(JSON.stringify({ artefatos: relatorio }, null, 2));
  } else {
    // A pendência é SUBCONJUNTO do aplicado, não categoria irmã: escrita como
    // "· N com pendência" ao lado de "· M aplicado(s)" parecia soma (issue#2812).
    let rodape = `\n${relatorio.length} artefato(s) · ${bloqueados} bloqueado(s)`;
    if (operacao === 'apply') {
      rodape += ` · ${aplicados} aplicado(s)`;
      if (aplicadosComPendencia > 0) rodape += ` — ${aplicadosComPendencia} deles com pendência`;
    } else if (pendentes > 0) {
      rodape += ` · ${pendentes} com pendência`;
    }
    ctx.out(rodape);
    if (pendentes > 0) {
      ctx.out(
        'Crie o que falta no Hub e rode adk deploy de novo (adk status lista o que está pendente).',
      );
    }
  }
  // Só BLOQUEIO real sai com código de erro (para a CLI servir de passo de CI).
  // Pendência de referência não falha a rodada: o apply funciona, a linha vai
  // para `AdkPendency` e quem recusa é o portão de ativação (issue#2677).
  return bloqueados > 0 ? 1 : 0;
}

function mesmasAreas(a: Record<string, string>, b: Record<string, string>): boolean {
  const chaves = Object.keys(a);
  return chaves.length === Object.keys(b).length && chaves.every((k) => a[k] === b[k]);
}

function bloqueiosSemSuporte(campos: readonly CampoComEco[]): LinhaRelatorio['blocking'] {
  return campos.map((campo) => ({
    code: 'hub_sem_suporte',
    path: campo,
    message: mensagemSemSuporte(campo),
  }));
}

/**
 * Trava de apply em produção (docs/adk-externo, ticket 02): com o perfil
 * `prod` padrão, um `adk apply` sem nada configurado grava em produção, e não
 * existe `adk rollback`. Num terminal, a pessoa digita o id da org ou o nome
 * da pasta; fora dele (CI, agente), só `--yes` libera. Devolve 0 para seguir,
 * ou o exit code da recusa — sempre ANTES de qualquer chamada ao Hub.
 */
async function confirmarProducao(ctx: Ctx, org: string, doOrg: Artefato[]): Promise<number> {
  if (!temTerminal(ctx)) {
    ctx.err(
      `Apply em produção (org ${org}) sem terminal para confirmar: passe --yes para aplicar ` +
        'sem pergunta (CI), ou rode num terminal. Nada foi aplicado.',
    );
    return 2;
  }
  const pastas = [...new Set(doOrg.map((a) => a.org))];
  const resposta = await perguntar(
    ctx,
    `Isto vai APLICAR em PRODUÇÃO na organização ${org} (orgs/${pastas.join(', orgs/')}).
` + `Para confirmar, digite o id da org ou o nome da pasta (${pastas.join(' / ')}):`,
  );
  if (resposta === org || pastas.includes(resposta)) return 0;
  ctx.err('A resposta não confere com a organização — nada foi aplicado.');
  return 1;
}

/**
 * Contagem do rodapé — pura, para ter teste (issue#2812, issue#2677).
 *
 * - `bloqueados`: artefato com `blocking[]` (ou erro de execução). Pendência
 *   NÃO entra aqui.
 * - `pendentes`: artefato SEM bloqueio, com referência ainda não resolvida.
 *   Pode ter sido aplicado (é o caso comum no apply): é um aviso, não um estado
 *   excludente.
 * - `aplicados`: gravação confirmada pelo servidor e SEM bloqueio — assim
 *   `bloqueados + aplicados` nunca passa do total.
 */
export function contagemDoRelatorio(relatorio: LinhaRelatorio[]): {
  bloqueados: number;
  pendentes: number;
  aplicados: number;
  /** Subconjunto de `aplicados` que também tem pendência aberta. */
  aplicadosComPendencia: number;
} {
  const bloqueado = (l: LinhaRelatorio) => l.blocking.length > 0;
  return {
    bloqueados: relatorio.filter(bloqueado).length,
    pendentes: relatorio.filter((l) => !bloqueado(l) && l.pending.length > 0).length,
    aplicados: relatorio.filter((l) => !bloqueado(l) && l.applied).length,
    aplicadosComPendencia: relatorio.filter(
      (l) => !bloqueado(l) && l.applied && l.pending.length > 0,
    ).length,
  };
}

function imprimirPlano(ctx: Ctx, nome: string, linha: LinhaRelatorio): void {
  for (const l of linhasDoPlano(nome, linha)) ctx.out(l);
}

/** As linhas que o `plan`/`deploy` imprimem para UM artefato — pura, para ter teste. */
export function linhasDoPlano(nome: string, linha: LinhaRelatorio): string[] {
  // Pendência é listada em TODOS os ramos: esconder atrás de um bloqueio faria
  // o operador só descobri-la depois de corrigir o bloqueio.
  const pendencias = linha.pending.map(
    (p) =>
      `      ${p.field}: "${p.slug}" ${p.reason === 'ambiguous' ? 'está ambíguo' : 'não existe nesta organização'}`,
  );
  if (linha.blocking.length > 0) {
    const saida = [`  ✗ ${nome}: bloqueado`];
    for (const b of linha.blocking) saida.push(`      ${b.path}: ${b.message}`);
    if (pendencias.length > 0) {
      saida.push('    ! pendência: não entra no ar até você resolver:', ...pendencias);
    }
    return saida;
  }
  // Pendência NÃO bloqueia o apply (o artefato é gravado), mas a ativação
  // recusa até a referência existir — e as alterações abaixo, inclusive
  // DESVINCULAR, continuam valendo e têm de aparecer (issue#2677, issue#2776).
  const aviso =
    pendencias.length > 0
      ? ['    ! pendência: não entra no ar até você resolver:', ...pendencias]
      : [];
  if (
    linha.action === 'noop' &&
    linha.collaborators.length === 0 &&
    linha.toolBindings.length === 0 &&
    linha.toolRevocations.length === 0 &&
    !linha.agentControl
  ) {
    return [`  = ${nome}: sem alteração`, ...aviso];
  }
  const criando = linha.action === 'create';
  const saida = [`  → ${nome}: ${criando ? 'criar' : 'atualizar'}`, ...aviso];
  // Agente novo não tem "antes": o Hub manda a mudança sem `from`.
  for (const c of linha.changes) {
    const valor = criando
      ? JSON.stringify(c.to)
      : `${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
    saida.push(`      ${c.field}: ${valor}`);
  }
  for (const c of linha.collaborators) saida.push(`      colaborador ${c.agent}: ${c.action}`);
  if (linha.agentControl) {
    saida.push(
      `      agent_control.areas: ${JSON.stringify(linha.agentControl.from ?? {})} → ${JSON.stringify(linha.agentControl.to)}`,
    );
  }
  // A REMOÇÃO é o que precisa saltar aos olhos: o incidente #1005 apagou 17
  // vínculos em produção, e esta é a última tela antes da escrita onde alguém
  // pode ver isso acontecer (issue#2776).
  for (const b of linha.toolBindings) {
    const rotulo =
      b.action === 'create' ? 'vincular' : b.action === 'remove' ? 'DESVINCULAR' : 'alterar';
    const alcance =
      b.alcance && b.alcance.from !== b.alcance.to
        ? `, alcance ${b.alcance.from ?? 'SO_QUEM_FALA'} → ${b.alcance.to}`
        : '';
    saida.push(`      tool ${b.name}: ${rotulo}${alcance}`);
  }
  for (const r of linha.toolRevocations) {
    saida.push(`      tool ${r.declared ?? r.name}: remover vínculo`);
  }
  return saida;
}
