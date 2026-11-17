/**
 * Versão da CLI — a do `package.json` do próprio pacote, lida em tempo de
 * execução. Literal no código deriva a cada release (a 0.2.0 saiu dizendo
 * "0.1.0"); o `package.json` é o que vai no tarball, ao lado do `dist/`.
 *
 * Resolvido a partir de `import.meta.url`, não do cwd: `src/versao.ts` (tsx,
 * vitest) e `dist/versao.js` (o pacote instalado) ficam ambos um nível abaixo
 * do `package.json`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let versaoLida: string | undefined;

export function versaoDaCli(): string {
  if (versaoLida === undefined) {
    const caminho = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(caminho, 'utf8')) as { version?: unknown };
    if (typeof pkg.version !== 'string' || pkg.version === '') {
      throw new Error(`package.json da CLI sem "version": ${caminho}`);
    }
    versaoLida = pkg.version;
  }
  return versaoLida;
}
