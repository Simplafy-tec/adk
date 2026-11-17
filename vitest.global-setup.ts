/**
 * Constrói os pacotes antes da suíte.
 *
 * A CLI importa `@simpla.fy/adk-contract` pelo NOME do pacote (é assim que
 * ela vai rodar publicada), e o link do workspace aponta para `dist/`. O teste
 * do `mcp-server` ainda spawna a CLI num processo à parte, sem os alias do
 * vitest — sem build, esse processo morre com "cannot find module" e o erro
 * aparece como timeout do cliente MCP, que não diz nada.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('.', import.meta.url));

export default function setup(): void {
  // Ordem = ordem de dependência: o contrato antes da CLI, a CLI antes do
  // template que a embrulha. O app-kit entra porque o `npm pack --dry-run` do
  // `test/publish.test.ts` audita o `dist/` dele.
  for (const pacote of ['contract', 'cli', 'app-kit', 'create-simplafy-app']) {
    execFileSync(
      process.platform === 'win32' ? 'tsc.cmd' : 'node_modules/.bin/tsc',
      ['-p', `packages/${pacote}/tsconfig.json`],
      { cwd: raiz, stdio: 'inherit' },
    );
  }
}
