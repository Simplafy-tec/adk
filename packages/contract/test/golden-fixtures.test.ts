import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpecYaml, validateSpecStructureAs } from '../src/index.js';

// Golden: mesma FORMA da fixture de jornada do hub-v2
// (apps/api/src/adk/fixtures/, origin/staging), com nomes sintéticos — dado de
// cliente não vai para pacote público. Prova que o validador portado produz o
// MESMO resultado (sem issues bloqueantes) que o hub-v2 espera do arquivo.
const fixturePath = fileURLToPath(
  new URL('./fixtures/jornada-exemplo-360.yaml', import.meta.url),
);

describe('golden — fixture com a forma da do hub-v2', () => {
  it('jornada-exemplo-360.yaml (journey de disparo por fase) valida sem issues bloqueantes', () => {
    const texto = readFileSync(fixturePath, 'utf8');
    const spec = parseSpecYaml(texto);
    const issues = validateSpecStructureAs('journey', spec);
    expect(issues).toEqual([]);
  });

  it('o slug do golden casa com o nome do arquivo (scanLeaks não acusa slug_filename_mismatch)', () => {
    const texto = readFileSync(fixturePath, 'utf8');
    const spec = parseSpecYaml(texto);
    expect(spec.slug).toBe('jornada-exemplo-360');
  });
});
