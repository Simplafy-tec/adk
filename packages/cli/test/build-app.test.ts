import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// `adk build` para `kind: app` roda o lint de aderência (ui_adherence) além do
// que já roda para tool/mcp — MESMAS regras que `checkAgainstPolicy` usa no
// apply do Hub (GATE 3: "mesmo resultado em adk build e no apply").

function manifestoApp(): string {
  return [
    'spec_version: v1',
    'kind: app',
    'slug: demo-app',
    'entryPoints:',
    '  ui: src/App.tsx',
    'ui:',
    '  adherence: true',
    'definition:',
    '  name: demo_app',
    '  display_name: demo-app',
    '  description: App de demonstração com mais de vinte caracteres no total.',
    '  kind: native',
    '  input_schema:',
    '    type: object',
    '    properties: {}',
    '',
  ].join('\n');
}

describe('adk build — kind: app (ui_adherence)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-app-'));
    writeFileSync(join(dir, 'manifest.yaml'), manifestoApp());
    mkdirSync(join(dir, 'src'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reprova cor literal (#fff) em src/App.tsx com o código ui_adherence, exit 1', async () => {
    writeFileSync(
      join(dir, 'src', 'App.tsx'),
      'export const App = () => <div style={{ color: "#ffffff" }}>oi</div>;\n',
    );
    const result = await runCli(['build'], { cwd: dir });
    expect(result.exitCode).toBe(1);
    const issues = JSON.parse(result.stdout).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
  });

  it('reprova <img> de logo fora de <Brand/> com o código ui_adherence, exit 1', async () => {
    writeFileSync(
      join(dir, 'src', 'App.tsx'),
      'export const App = () => <img src="logo.png" alt="Simplafy" />;\n',
    );
    const result = await runCli(['build'], { cwd: dir });
    expect(result.exitCode).toBe(1);
    const issues = JSON.parse(result.stdout).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
  });

  it('app limpo (tokens + <Brand/>) passa o lint de aderência, exit 0', async () => {
    writeFileSync(
      join(dir, 'src', 'App.tsx'),
      [
        'import { Brand } from "@simpla.fy/app-kit";',
        'export const App = () => (',
        '  <div style={{ color: "var(--color-primary)" }}>',
        '    <Brand />',
        '  </div>',
        ');',
        '',
      ].join('\n'),
    );
    const result = await runCli(['build'], { cwd: dir });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues.filter((i: { code: string }) => i.code === 'ui_adherence')).toEqual([]);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ nome: 'ui_adherence', ok: true }),
    );
    expect(result.exitCode).toBe(0);
  });
});
