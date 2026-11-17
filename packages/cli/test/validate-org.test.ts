import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Achado da prova dos 7 passos (0.3.1): `adk validate --org <id>` dava «unknown option '--org'», enquanto plan/apply/status/export
// aceitam. Agora `--org` restringe a validação à pasta da organização, sem falar com o Hub.

const ENV = { ADK_HUB_URL: 'http://hub-mock.test', ADK_TOKEN: 'fake-token' };
const TOOL_OK = 'spec_version: v1\nkind: tool\nslug: consulta\ndefinition:\n  name: consulta\n  display_name: Consulta\n  description: Consulta um cadastro e devolve os dados do registro.\n  kind: native\n  input_schema:\n    type: object\n    properties: {}\n';

let dir: string;
function org(pasta: string, id: string, arquivos: Record<string, string>) {
  mkdirSync(join(dir, 'orgs', pasta, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'orgs', pasta, 'org.yaml'), `environments:\n  staging: ${id}\n`);
  for (const [nome, conteudo] of Object.entries(arquivos)) writeFileSync(join(dir, 'orgs', pasta, 'tools', nome), conteudo);
}

describe('adk validate --org', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-validate-org-'));
    org('acme', 'org-acme', { 'consulta.yaml': TOOL_OK });
    org('beta', 'org-beta', { 'quebrada.yaml': 'spec_version: v1\nkind: tool\nslug: quebrada\n' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('aceita --org e valida só a pasta dessa organização', async () => {
    const r = await runCli(['validate', '--org', 'org-acme', '--dir', dir], { env: ENV });
    expect(r.stderr).not.toContain('unknown option');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('acme/tool/consulta.yaml');
    expect(r.stdout).not.toContain('beta/');
    expect(r.stdout).toContain('1 artefato(s), 0 com problema');
  });

  it('sem --org continua validando todas as organizações (a da pasta beta reprova)', async () => {
    const r = await runCli(['validate', '--dir', dir], { env: ENV });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('beta/tool/quebrada.yaml');
  });

  it('--org da organização com problema reprova', async () => {
    const r = await runCli(['validate', '--org', 'org-beta', '--dir', dir], { env: ENV });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('acme/');
  });

  it('--org que nenhuma pasta declara recusa com exit 2 e diz o ambiente', async () => {
    const r = await runCli(['validate', '--org', 'org-fantasma', '--dir', dir], { env: ENV });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Nenhuma pasta de organização declara "org-fantasma"');
  });
});
