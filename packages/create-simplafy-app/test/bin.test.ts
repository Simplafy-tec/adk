import { describe, expect, it } from 'vitest';
import { main } from '../src/bin.js';

// Item 6 do brief de correção N19: `create-simplafy-app/src/bin.ts` não tinha
// teste — hoje ele chama `process.exit` direto no topo do módulo, então
// importar o arquivo mataria o processo do vitest. O fix exporta `main`
// (recebe o argv, devolve o exit code) e só o topo do script real chama
// `process.exit`. Dois branches: sem args ⇒ exit 2; `--help` ⇒ exit 0.

describe('create-simplafy-app — bin (main)', () => {
  it('sem argumentos ⇒ exit 2 com instrução de uso', async () => {
    const exitCode = await main([]);
    expect(exitCode).toBe(2);
  });

  it('--help ⇒ exit 0 com instrução de uso, sem rodar o init', async () => {
    const exitCode = await main(['--help']);
    expect(exitCode).toBe(0);
  });

  it('-h ⇒ exit 0', async () => {
    const exitCode = await main(['-h']);
    expect(exitCode).toBe(0);
  });
});
