import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// `adk init app <nome>` gera um app Vite+React+TS sobre @simpla.fy/app-kit
// (ADR-120 §4/§5) — árvore diferente de `init tool`/`init mcp`: sem
// pyproject.toml/.python-version (não é Python) e sem CLAUDE.md (igual aos
// outros kinds).

describe('adk init app', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-app-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cria a árvore do app com exit 0', async () => {
    const result = await runCli(['init', 'app', 'demo-app', '--dir', join(dir, 'demo-app')], {
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
  });

  it('init → build: o TEMPLATE gerado passa no ui_adherence (o scaffold da plataforma nunca reprova no 1º build)', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues.filter((i: { code: string }) => i.code === 'ui_adherence')).toEqual([]);
  });

  it('manifest.yaml declara kind: app, entryPoints e ui.adherence: true', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    const manifesto = readFileSync(join(alvo, 'manifest.yaml'), 'utf8');
    expect(manifesto).toMatch(/kind:\s*app/);
    expect(manifesto).toMatch(/entryPoints:/);
    expect(manifesto).toMatch(/adherence:\s*true/);
  });

  it('gera src/App.tsx e package.json com @simpla.fy/app-kit', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    expect(existsSync(join(alvo, 'src', 'App.tsx'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(alvo, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@simpla.fy/app-kit']).toBeDefined();
  });

  it('gera dev/sample-context.json', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    expect(existsSync(join(alvo, 'dev', 'sample-context.json'))).toBe(true);
  });

  it('não gera CLAUDE.md', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    expect(existsSync(join(alvo, 'CLAUDE.md'))).toBe(false);
  });

  it('não gera pyproject.toml nem .python-version (app não é Python)', async () => {
    const alvo = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', alvo], { cwd: dir });
    expect(existsSync(join(alvo, 'pyproject.toml'))).toBe(false);
    expect(existsSync(join(alvo, '.python-version'))).toBe(false);
  });

// A N10 foi ENTREGUE: `kind: mcp` e `kind: app` são aceitos no deploy — provado
// em staging, nas orgs duas orgs de exemplo (`adk deploy` com 0 bloqueados). Mas o
// `init` seguia avisando que o servidor recusa "até a N10", tanto na saída do
// comando quanto no README gerado.
//
// Aviso obsoleto é pior que aviso nenhum: manda o autor não tentar exatamente o
// que já funciona, e ele não tem como saber que a informação venceu.
  describe('adk init — o aviso da N10 não sobrevive à N10', () => {
  for (const kind of ['mcp', 'app'] as const) {
    it(`init ${kind} não avisa que o deploy é recusado`, async () => {
      const alvo = join(dir, `demo-${kind}`);
      const result = await runCli(['init', kind, `demo-${kind}`, '--dir', alvo], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('unknown_kind');
      expect(result.stdout).not.toContain('N10');
    });

    it(`o README gerado por init ${kind} não diz que o kind não é aceito`, async () => {
      const alvo = join(dir, `demo-${kind}`);
      await runCli(['init', kind, `demo-${kind}`, '--dir', alvo], { cwd: dir });
      const readme = readFileSync(join(alvo, 'README.md'), 'utf8');
      expect(readme).not.toContain('unknown_kind');
      expect(readme).not.toContain('não é aceito no deploy');
    });
  }

  it('o próximo passo sugerido inclui o deploy para mcp e app, não só para tool', async () => {
    const alvo = join(dir, 'demo-mcp2');
    const result = await runCli(['init', 'mcp', 'demo-mcp2', '--dir', alvo], { cwd: dir });
    // Sem isto o teste acima passaria com a linha do "Próximo passo" apagada:
    // some o aviso errado E some a orientação certa.
    expect(result.stdout).toContain('adk deploy');
  });
});

});
