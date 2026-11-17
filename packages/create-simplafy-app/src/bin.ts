#!/usr/bin/env node
/**
 * `npm init @simpla.fy/app <nome>` — atalho conhecido para `adk init app`.
 *
 * Bin e nada mais: a árvore é gerada pela CLI, então o template nunca diverge
 * do que o `adk build` valida. Duplicar o esqueleto aqui criaria dois
 * scaffolds com regras diferentes.
 */

import { runCli } from '@simpla.fy/adk';

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write('Uso: npm init @simpla.fy/app <nome> [--dir <caminho>]\n');
    return argv.length === 0 ? 2 : 0;
  }

  const resultado = await runCli(['init', 'app', ...argv], { stream: true });
  return resultado.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
