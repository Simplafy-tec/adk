import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { gerarSatelite } from './satelite-processo.js';

// Hub#2.6.26.4 — `adk init mcp --runtime node <nome>` gera um satélite MCP em
// Node, irmão de `arvoreApp()`. O runtime é ortogonal ao kind: só o COMO o
// componente é escrito muda; o manifesto continua sendo o mesmo `kind: mcp`
// chapado que o apply do Hub já julga (issue#2768) — nenhum campo novo.

describe('adk init mcp --runtime node', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-mcp-node-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gera package.json, tsconfig.json, src/server.ts, test/ e .gitignore cobrindo node_modules/ e dist/', async () => {
    const alvo = join(dir, 'satelite-node');
    const result = await runCli(
      ['init', 'mcp', '--runtime', 'node', 'satelite-node', '--dir', alvo],
      { cwd: dir },
    );
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(alvo, 'package.json'))).toBe(true);
    expect(existsSync(join(alvo, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(alvo, 'src', 'server.ts'))).toBe(true);
    expect(existsSync(join(alvo, 'README.md'))).toBe(true);

    const gitignore = readFileSync(join(alvo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env*');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('dist/');
  });

  it('não gera pyproject.toml, .python-version, server.py nem CLAUDE.md', async () => {
    const alvo = join(dir, 'satelite-node-2');
    const result = await runCli(
      ['init', 'mcp', '--runtime', 'node', 'satelite-node-2', '--dir', alvo],
      { cwd: dir },
    );
    // Sem isto o teste passaria vazio quando `--runtime` nem existir ainda
    // (a pasta nunca nasce, e "não existe" fica indistinguível de "não gera").
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(alvo, 'pyproject.toml'))).toBe(false);
    expect(existsSync(join(alvo, '.python-version'))).toBe(false);
    expect(existsSync(join(alvo, 'server.py'))).toBe(false);
    expect(existsSync(join(alvo, 'CLAUDE.md'))).toBe(false);
  });

  it('o manifesto é o mesmo manifestoMcp chapado do caminho Python — sem campo de runtime', async () => {
    const alvo = join(dir, 'satelite-node-3');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-3', '--dir', alvo], {
      cwd: dir,
    });
    const yaml = readFileSync(join(alvo, 'manifest.yaml'), 'utf8');
    expect(yaml).toMatch(/kind:\s*mcp/);
    expect(yaml).toMatch(/^name:/m);
    expect(yaml).toMatch(/image:.*TROQUE/);
    expect(yaml.toLowerCase()).toContain('sha256');
    expect(yaml.toLowerCase()).toContain('digest');
    expect(yaml).toMatch(/url:.*TROQUE/);
    expect(yaml).toMatch(/tools:\s*\[\]/);
    expect(yaml).not.toMatch(/^definition:/m);
    // O runtime não é um campo do manifesto — só existe na decisão do `adk init`/`adk dev`.
    expect(yaml.toLowerCase()).not.toMatch(/runtime:\s*node/);
  });

  it('package.json declara a dependência do SDK MCP que src/server.ts importa, e os scripts de dev/teste', async () => {
    const alvo = join(dir, 'satelite-node-4');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-4', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    expect(server).toContain('@modelcontextprotocol/sdk');

    const pkg = JSON.parse(readFileSync(join(alvo, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.scripts?.dev).toBeTruthy();
    expect(pkg.scripts?.test).toBeTruthy();
  });

  it('o script `dev` do package.json NÃO tem watcher próprio (quem observa e reinicia é o supervisor do ADK)', async () => {
    // Item 5 do COMO: dois watchers sobre a mesma árvore (o do template + o
    // supervisor do ADK) dobram o consumo de inotify e já estouraram
    // ENOSPC neste host, derrubando o `adk dev` inteiro (exit 13). O script
    // que o `adk dev` dispara tem que rodar o servidor uma vez e sair
    // quando morre — sem `--watch`, `tsx watch` ou `nodemon`.
    const alvo = join(dir, 'satelite-node-5');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-5', '--dir', alvo], {
      cwd: dir,
    });
    const pkg = JSON.parse(readFileSync(join(alvo, 'package.json'), 'utf8'));
    const scriptDev = String(pkg.scripts?.dev ?? '');
    expect(scriptDev).not.toMatch(/watch|nodemon/i);
  });

  it.each(['transporte', 'mcp'])(
    'o `%s.close()` no fechamento da resposta trata a rejeição com `.catch` (sem unhandled rejection)',
    async (objeto) => {
      // `void x.close()` só descarta a promise: se ela rejeitar, o Node 20+
      // derruba o processo por unhandled rejection — no satélite em produção,
      // um request encerrado no meio vira pod reiniciando.
      const alvo = join(dir, `satelite-node-close-${objeto}`);
      await runCli(['init', 'mcp', '--runtime', 'node', `satelite-node-close-${objeto}`, '--dir', alvo], {
        cwd: dir,
      });
      const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
      const chamadas = [...server.matchAll(new RegExp(`\\b${objeto}\\.close\\(\\)(\\s*\\.catch\\()?`, 'g'))];
      // Sem a chamada o teste passaria vazio — e fechar o transporte é obrigatório.
      expect(chamadas.length).toBeGreaterThan(0);
      for (const chamada of chamadas) expect(chamada[0]).toMatch(/\.catch\($/);
    },
  );

  it('--runtime com valor desconhecido sai com exit 2 e lista os valores válidos', async () => {
    const alvo = join(dir, 'satelite-invalido');
    const result = await runCli(
      ['init', 'mcp', '--runtime', 'rust', 'satelite-invalido', '--dir', alvo],
      { cwd: dir },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('python');
    expect(result.stderr).toContain('node');
    expect(existsSync(alvo)).toBe(false);
  });

  it.each(['tool', 'app'] as const)(
    '--runtime node com kind: %s sai com exit 2 acionável (só kind: mcp aceita runtime node nesta fatia)',
    async (kind) => {
      const alvo = join(dir, `demo-${kind}-node`);
      const result = await runCli(
        ['init', kind, '--runtime', 'node', `demo-${kind}-node`, '--dir', alvo],
        { cwd: dir },
      );
      expect(result.exitCode).toBe(2);
      expect(existsSync(alvo)).toBe(false);
    },
  );

  // issue#2818 (#36) vale para o satélite Node como vale para o Python: o
  // manifesto exige `image` por digest, e sem Dockerfile o ciclo
  // init → build → deploy trava no fim.
  it('gera Dockerfile e .dockerignore', async () => {
    const alvo = join(dir, 'satelite-node-docker');
    const result = await runCli(
      ['init', 'mcp', '--runtime', 'node', 'satelite-node-docker', '--dir', alvo],
      { cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(alvo, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(alvo, '.dockerignore'))).toBe(true);
  });

  it('a imagem nasce não-root (USER numérico ≠ 0, depois do último COPY) e sobe o servidor do próprio init', async () => {
    const alvo = join(dir, 'satelite-node-docker-2');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-docker-2', '--dir', alvo], {
      cwd: dir,
    });
    const d = readFileSync(join(alvo, 'Dockerfile'), 'utf8');
    // Numérico: `runAsNonRoot` do kubelet só consegue verificar uid, não nome.
    const user = /^USER\s+(\S+)\s*$/m.exec(d)?.[1];
    expect(user).toMatch(/^[1-9]\d*$/);
    expect(d.lastIndexOf('USER ')).toBeGreaterThan(d.lastIndexOf('COPY '));
    // Nada de `USER root` reaparecendo depois.
    expect(d.slice(d.lastIndexOf('USER '))).not.toMatch(/^USER\s+(root|0)\b/m);
    expect(d).toMatch(/server/);
    expect(d).not.toContain('server.py');
  });

  it('o .dockerignore deixa node_modules e .env* fora do contexto', async () => {
    const alvo = join(dir, 'satelite-node-docker-3');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-docker-3', '--dir', alvo], {
      cwd: dir,
    });
    const linhas = readFileSync(join(alvo, '.dockerignore'), 'utf8').split('\n');
    expect(linhas).toContain('node_modules/');
    expect(linhas).toContain('.env*');
    // `.npmrc` costuma guardar o token do registry: `COPY . .` o levaria para a imagem.
    expect(linhas).toContain('.npmrc');
  });

  it('o Dockerfile instala só do lock: `COPY package.json package-lock.json ./` (lock obrigatório) e `npm ci`', async () => {
    const alvo = join(dir, 'satelite-node-docker-4');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-docker-4', '--dir', alvo], {
      cwd: dir,
    });
    const d = readFileSync(join(alvo, 'Dockerfile'), 'utf8');
    expect(d).toContain('COPY package.json package-lock.json ./');
    // `package-lock.json*` torna o lock opcional: o COPY passa sem ele e a
    // imagem resolve dependência por conta própria.
    expect(d).not.toContain('package-lock.json*');
    expect(d).toMatch(/^RUN .*\bnpm ci\b/m);
    expect(d).not.toMatch(/\bnpm install\b/);
  });

  it('o tsconfig gerado aceita o teste importar `../src/server.ts`: `tsc --noEmit` no esqueleto passa', async () => {
    const alvo = await gerarSatelite(dir, 'node', 'satelite-node-tsc');
    const tsc = join(alvo, 'node_modules', '.bin', 'tsc');
    const r = spawnSync(tsc, ['--noEmit', '-p', '.'], { cwd: alvo, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  }, 90_000);

  it('nasce com harness de teste próprio (script `test` aponta para um arquivo que existe)', async () => {
    const alvo = join(dir, 'satelite-node-harness');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-harness', '--dir', alvo], {
      cwd: dir,
    });
    const pkg = JSON.parse(readFileSync(join(alvo, 'package.json'), 'utf8'));
    const scriptTest = String(pkg.scripts?.test ?? '');
    const arquivos = scriptTest.match(/[\w./-]+\.(?:ts|js|mjs)\b/g) ?? [];
    expect(arquivos.length).toBeGreaterThan(0);
    for (const a of arquivos) expect(existsSync(join(alvo, a))).toBe(true);
  });

  it('sem --runtime, `adk init mcp` continua gerando a árvore Python de hoje (zero regressão)', async () => {
    const alvo = join(dir, 'satelite-python');
    const result = await runCli(['init', 'mcp', 'satelite-python', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(alvo, 'server.py'))).toBe(true);
    expect(existsSync(join(alvo, 'pyproject.toml'))).toBe(true);
    expect(existsSync(join(alvo, 'package.json'))).toBe(false);
    expect(existsSync(join(alvo, 'src', 'server.ts'))).toBe(false);
  });

  it('`--runtime python` explícito gera a MESMA árvore que sem a flag', async () => {
    const semFlag = join(dir, 'py-sem-flag');
    const comFlag = join(dir, 'py-com-flag');
    await runCli(['init', 'mcp', 'satelite-py', '--dir', semFlag], { cwd: dir });
    const result = await runCli(['init', 'mcp', '--runtime', 'python', 'satelite-py', '--dir', comFlag], {
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    for (const f of ['server.py', 'pyproject.toml', 'Dockerfile', '.dockerignore', 'manifest.yaml']) {
      expect(readFileSync(join(comFlag, f), 'utf8')).toBe(readFileSync(join(semFlag, f), 'utf8'));
    }
  });
});
