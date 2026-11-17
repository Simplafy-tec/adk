/**
 * Pergunta de uma linha ao humano no terminal.
 *
 * Só pergunta num TTY de verdade (`stdin.isTTY === true`): CI, pipe e agente
 * não têm quem responda, e ler deles transformaria "ninguém digitou" em
 * resposta. Quem chama decide o que fazer fora de TTY (em geral, exit 2).
 */

import { createInterface } from 'node:readline';
import type { Ctx } from './ctx.js';

export function temTerminal(ctx: Ctx): boolean {
  return ctx.stdin?.isTTY === true;
}

/**
 * Mostra `texto` na saída de erro (não polui o `--json`) e devolve a linha
 * digitada, sem espaços nas pontas. Entrada encerrada sem linha vale `''`.
 */
export function perguntar(ctx: Ctx, texto: string): Promise<string> {
  const entrada = ctx.stdin;
  if (!entrada) return Promise.resolve('');
  ctx.err(texto);
  const rl = createInterface({ input: entrada, terminal: false });
  return new Promise((resolver) => {
    let respondido = false;
    rl.once('line', (linha) => {
      respondido = true;
      rl.close();
      resolver(linha.trim());
    });
    rl.once('close', () => {
      if (!respondido) resolver('');
    });
  });
}
