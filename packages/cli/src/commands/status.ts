/**
 * `adk status` — as pendências ABERTAS da organização (issue#2773).
 *
 * O fluxo do ADK gera pendência POR DESENHO: referência que não resolve não
 * aborta o apply, vira `AdkPendency` (N2). Sem este comando, a pendência que o
 * próprio produto criou só existia na tela — um agente headless não tinha como
 * sabê-la, e a ADR-121 §11.3 já a listava como comando de v1.
 */

import { buscarAdk } from '../hub.js';
import type { Ctx } from '../ctx.js';

/** A linha como o Hub a devolve (`AdkPendency`). */
interface Pendencia {
  id: string;
  kind: string;
  entityId: string;
  /** Endereço da referência NO ARQUIVO: `references.channel`, `connections[0]`. */
  path: string;
  /** `not_found` | `ambiguous`. */
  code: string;
  slug: string;
  /** Frase pronta do servidor — lista os candidatos quando é ambiguidade. */
  message: string;
  createdAt?: string;
}

export async function comandoStatus(
  ctx: Ctx,
  opcoes: { org?: string; kind?: string; json?: boolean },
): Promise<number> {
  if (!opcoes.org) {
    ctx.err('Informe --org <id da organização>.');
    return 2;
  }

  let pendencias: Pendencia[];
  try {
    pendencias = await buscarAdk<Pendencia[]>(ctx, 'pendencies', {
      orgId: opcoes.org,
      ...(opcoes.kind ? { kind: opcoes.kind } : {}),
    });
  } catch (e) {
    ctx.err((e as Error).message);
    return 1;
  }

  if (opcoes.json) {
    ctx.out(JSON.stringify({ pendencias }, null, 2));
    // Pendência não é erro: ela é o estado que o produto produz de propósito.
    // Sair 1 aqui faria todo CI com pendência legítima ficar vermelho.
    return 0;
  }

  if (pendencias.length === 0) {
    ctx.out(`Nenhuma pendência aberta na organização ${opcoes.org}.`);
    return 0;
  }

  ctx.out(`${pendencias.length} pendência(s) aberta(s) na organização ${opcoes.org}:\n`);
  for (const p of pendencias) {
    // `path` é o endereço no ARQUIVO (`references.channel`) e `code` é o motivo
    // — os nomes da linha que o Hub devolve. A primeira versão lia `field` e
    // `reason`, que não existem, e imprimia `undefined` justamente no lugar
    // mais útil quando há várias pendências.
    const motivo = p.code === 'ambiguous' ? 'está ambíguo' : 'não existe nesta organização';
    ctx.out(`  ! ${p.kind} ${p.entityId} — ${p.path}: "${p.slug}" ${motivo}`);
    // Na ambiguidade, a mensagem do servidor lista os candidatos: sem ela a
    // pessoa sabe que está ambíguo e não sabe entre o quê.
    if (p.code === 'ambiguous' && p.message) ctx.out(`      ${p.message}`);
  }
  ctx.out('\nResolva criando a referência no Hub e rodando `adk deploy` de novo.');
  return 0;
}
