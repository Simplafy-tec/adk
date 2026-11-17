import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// `adk build` roda os validadores do contrato + scanLeaks sobre o script Python
// gerado por `adk init tool` — mesmo código que o servidor devolve no apply
// (mutation check do AC4): secret_literal.

describe('adk build', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-'));
    writeFileSync(
      join(dir, 'manifest.yaml'),
      ['spec_version: v1', 'kind: tool', 'slug: hello', 'definition:', '  name: hello', '  description: Diz olá para quem chamar, com mais de vinte caracteres.', '  kind: native', '  input_schema:', '    type: object', '    properties: {}'].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reprova segredo literal no script com o código secret_literal, exit 1', async () => {
    const toolsDir = join(dir, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(
      join(toolsDir, 'hello.py'),
      ['def handler(input):', '    token = "sk-abcdefgh12345678"', '    return {"ok": True}'].join('\n'),
    );
    const result = await runCli(['build'], { cwd: dir });
    expect(result.exitCode).toBe(1);
    const issues = JSON.parse(result.stdout).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('manifesto sem segredo passa (exit 0)', async () => {
    mkdirSync(join(dir, 'tools'));
    writeFileSync(
      join(dir, 'tools', 'hello.py'),
      ['def handler(input):', '    return {"ok": True}'].join('\n'),
    );
    const result = await runCli(['build'], { cwd: dir });
    expect(result.exitCode).toBe(0);
  });
});
