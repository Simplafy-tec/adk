import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// issue#2818 — `adk init mcp` entrega o que o manifesto exige: o caminho até
// uma imagem. O manifesto pede `image` por digest e digest só existe depois de
// um build; sem Dockerfile o ciclo init → build → deploy travava no fim.

describe('adk init mcp (python) — empacotamento (issue#2818)', () => {
  let dir: string;
  let alvo: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-mcp-docker-'));
    alvo = join(dir, 'satelite-exemplo');
    await runCli(['init', 'mcp', 'satelite-exemplo', '--dir', alvo], { cwd: dir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ler = (f: string) => readFileSync(join(alvo, f), 'utf8');

  it('gera Dockerfile e .dockerignore', () => {
    expect(existsSync(join(alvo, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(alvo, '.dockerignore'))).toBe(true);
  });

  it('a imagem nasce não-root (uid 10001) e o USER vem depois do COPY', () => {
    const d = ler('Dockerfile');
    expect(d).toMatch(/^USER 10001$/m);
    expect(d.indexOf('USER 10001')).toBeGreaterThan(d.indexOf('COPY . .'));
  });

  it('o .dockerignore deixa .venv e .env* fora do contexto', () => {
    const i = ler('.dockerignore').split('\n');
    expect(i).toContain('.venv/');
    expect(i).toContain('.env*');
  });

  it('sobe o server.py que o próprio init gerou, ouvindo fora do loopback', () => {
    const d = ler('Dockerfile');
    expect(d).toContain('CMD ["python", "server.py"]');
    expect(d).toContain('BIND_ADDRESS=0.0.0.0');
    expect(ler('server.py')).toContain('BIND_ADDRESS');
  });

  it('instala só do lock, com uv fixado, sem cache e sem chown do código', () => {
    const d = ler('Dockerfile');
    expect(d).toMatch(/pip install uv==\d+\.\d+\.\d+/);
    expect(d).toContain('COPY pyproject.toml uv.lock ./');
    expect(d).not.toContain('uv.lock*');
    expect(d).toMatch(/uv sync --locked /);
    expect(d).toContain('UV_NO_CACHE=1');
    expect(d).not.toContain('chown');
  });

  it.each(['tool', 'app'])('kind %s não ganha Dockerfile (só satélite vira imagem)', async (kind) => {
    const t = join(dir, `${kind}-x`);
    await runCli(['init', kind, `${kind}-x`, '--dir', t], { cwd: dir });
    expect(existsSync(join(t, 'Dockerfile'))).toBe(false);
  });
});
