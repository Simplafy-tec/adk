import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { arquivosDoPack } from './npm-pack.js';

// Publicação: package.json sem postinstall, publishConfig.access público,
// `npm pack --dry-run` não inclui .env*/credentials.json.

const pacotes = ['contract', 'cli'] as const;

describe.each(pacotes)('packages/%s — shape de publicação', (nome) => {
  const dir = fileURLToPath(new URL(`../packages/${nome}`, import.meta.url));

  it('package.json não tem script postinstall', () => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    expect(pkg.scripts?.postinstall).toBeUndefined();
  });

  it('engines.node exige >=20', () => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    expect(pkg.engines?.node).toBe('>=20');
  });

  it('publishConfig.access é public e files inclui dist', () => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.files).toContain('dist');
  });

  it('npm pack --dry-run --json não inclui .env* nem credentials.json', () => {
    const saida = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const arquivos = arquivosDoPack(saida);
    expect(arquivos.some((f) => f.startsWith('.env'))).toBe(false);
    expect(arquivos.some((f) => f.includes('credentials.json'))).toBe(false);
  });
});

// Item 5 do brief de correção N19: `storybook dev` sem `--host 127.0.0.1`
// publica o dev-server do app-kit na rede (default do Storybook é 0.0.0.0
// em algumas versões, e mesmo quando não é, não custa fixar o loopback como
// o resto da CLI já faz para `adk dev`).
it('packages/app-kit — script "storybook" fixa --host 127.0.0.1', () => {
  const dir = fileURLToPath(new URL('../packages/app-kit', import.meta.url));
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  expect(pkg.scripts?.storybook).toContain('--host 127.0.0.1');
});

it('packages/cli tem bin.adk apontando para o executável publicado', () => {
  const dir = fileURLToPath(new URL('../packages/cli', import.meta.url));
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  expect(pkg.bin?.adk).toBeDefined();
});

// Item 4 do brief de correção: fixture de PRODUÇÃO da org de cliente não pode ir no
// tarball público do npm — `files` do package.json não pode listar `fixtures`
// como pasta de dado real; golden fica em `test/fixtures/`, fora do pacote.
describe('packages/contract — fixtures não vão para o npm público', () => {
  const dir = fileURLToPath(new URL('../packages/contract', import.meta.url));

  it('npm pack --dry-run --json não inclui fixtures/disparo-avaliacao-360.yaml (config real da org de cliente)', () => {
    const saida = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
    const arquivos = arquivosDoPack(saida);
    expect(arquivos.some((f) => f.includes('disparo-avaliacao-360.yaml'))).toBe(false);
  });

  it('as fixtures golden usadas pelos testes não citam a org de cliente real nem seus templates/pipelines', () => {
    const golden = fileURLToPath(new URL('../packages/contract/test/fixtures', import.meta.url));
    const arquivos = readdirSync(golden);
    const conteudo = arquivos.map((f) => readFileSync(`${golden}/${f}`, 'utf8')).join('\n');
    expect(conteudo).not.toMatch(/agrobr|org-dev-\w+|template_convite_pesquisa360_agrobr_01/);
  });
});

// Item 10: publish.yml precisa trocar `npm publish` por `pnpm publish` — só o
// pnpm reescreve a dependência `workspace:*` do CLI para uma versão publicável;
// com `npm publish` o tarball sobe com `workspace:*` e `npx @simpla.fy/adk`
// (GATE 1) quebra na instalação.
it('.github/workflows/publish.yml publica com `pnpm publish`, não `npm publish`', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)),
    'utf8',
  );
  expect(workflow).toMatch(/pnpm publish/);
  expect(workflow).not.toMatch(/(?<![\w-])npm publish/);
});

// O job instala `npm@latest` para autenticar por OIDC (trusted publishing). O
// `npm@latest` de hoje é a 12.x e exige `node ^22.22.2 || ^24.15.0 || >=26`:
// com Node 20 o passo morre em EBADENGINE ANTES de publicar qualquer coisa —
// foi o que aconteceu no run 33534289349, com os 4 publishes pulados.
//
// O Node deste job é só a máquina que roda a ferramenta de publicação; não é o
// runtime alvo dos pacotes (esse continua declarado em `engines.node: >=20` e
// coberto pelo teste acima). Por isso ele pode e deve ser mais novo.
it('.github/workflows/publish.yml roda em Node >= 22 (npm@latest exige)', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)),
    'utf8',
  );
  const casado = /node-version:\s*'?(\d+)'?/.exec(workflow);
  expect(casado, 'publish.yml precisa fixar node-version').not.toBeNull();
  expect(Number(casado![1])).toBeGreaterThanOrEqual(22);
});

// GATE 5 (N19): pacote público não pode carregar dependência privada
// (@simplafy-tec/ui), segredo, nem componente exclusivo do produto.
describe('packages/app-kit — auditoria do bundle público (GATE 5)', () => {
  const dir = fileURLToPath(new URL('../packages/app-kit', import.meta.url));

  it('package.json não depende de @simplafy-tec/ui', () => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const todasDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
    expect(todasDeps['@simplafy-tec/ui']).toBeUndefined();
  });

  it('npm pack --dry-run --json não inclui .env* nem credentials.json', () => {
    const saida = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const arquivos = arquivosDoPack(saida);
    expect(arquivos.some((f) => f.startsWith('.env'))).toBe(false);
    expect(arquivos.some((f) => f.includes('credentials.json'))).toBe(false);
  });

  it('não exporta componente exclusivo do produto (AgentStudio*/BiConsole*/Inbox*/Journey*)', () => {
    const indice = readFileSync(`${dir}/src/index.ts`, 'utf8');
    expect(indice).not.toMatch(/\b(AgentStudio|BiConsole|Inbox|Journey)\w*/);
  });
});

// ── Publicação do release (Hub#2.6.21.82) ─────────────────────────────────────
//
// O repositório é privado e o npm recusa provenance vinda de repositório
// privado: `--provenance` fixo derrubou o publish da v0.2.0. O workflow tem de
// publicar SEM provenance enquanto o repo for privado e COM ela quando for
// público — sem perder a ordem dos pacotes, o portão de `workspace:` e o OIDC.

interface Passo {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

const workflowPublish = parseYaml(
  readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8'),
) as { jobs: Record<string, { permissions?: Record<string, string>; steps: Passo[] }> };

const [jobPublicar] = Object.values(workflowPublish.jobs);

/** Repositório no payload do evento do GitHub (`github.event.repository`). */
interface Repositorio {
  private: boolean;
  visibility: 'public' | 'private';
}
const REPO_PRIVADO: Repositorio = { private: true, visibility: 'private' };
const REPO_PUBLICO: Repositorio = { private: false, visibility: 'public' };

/**
 * Avalia uma expressão do Actions (`${{ ... }}` ou o `if:` cru) com o
 * repositório dado. Cobre o subconjunto que um condicional de visibilidade usa
 * (literais, `==`/`!=`, `!`, `&&`/`||` com a semântica de valor do Actions, que
 * é a do JS). Qualquer outro contexto lança — e reprova o teste.
 */
function avaliarExpressao(expressao: string, repo: Repositorio): unknown {
  const corpo = expressao.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const js = corpo
    .replace(/github\.event\.repository\.visibility/g, JSON.stringify(repo.visibility))
    .replace(/github\.event\.repository\.private/g, String(repo.private))
    .replace(/!=/g, '!==')
    .replace(/([^!=])==/g, '$1===');
  return new Function(`return (${js});`)();
}

/**
 * Valor efetivo de uma env do passo: a expressão que depende do repositório é
 * avaliada; o resto (texto puro, `secrets.*`) fica como está — não decide flag.
 */
function valorDaEnv(valor: string, repo: Repositorio): string {
  if (!valor.includes('${{') || !valor.includes('github.event.repository')) return valor;
  const v = avaliarExpressao(valor, repo);
  return v === false || v === null || v === undefined ? '' : String(v);
}

/** Comandos de publicação que de fato rodam, com as envs do passo expandidas. */
function publicacoesEfetivas(repo: Repositorio): string[] {
  return jobPublicar.steps
    .filter((p) => p.run?.includes('pnpm publish'))
    .filter((p) => p.if === undefined || Boolean(avaliarExpressao(p.if, repo)))
    .map((p) => {
      const env = Object.fromEntries(
        Object.entries(p.env ?? {}).map(([k, v]) => [k, valorDaEnv(String(v), repo)]),
      );
      return p.run!.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (todo, nome: string) =>
        nome in env ? env[nome] : todo,
      );
    })
    .map((run) => run.split('\n').filter((l) => l.includes('pnpm publish')).join('\n'));
}

describe('.github/workflows/publish.yml — provenance conforme a visibilidade do repositório', () => {
  it('com o repositório privado, publica e nenhum `pnpm publish` leva --provenance', () => {
    const comandos = publicacoesEfetivas(REPO_PRIVADO);
    expect(comandos.length).toBeGreaterThan(0);
    expect(comandos.join('\n')).not.toContain('--provenance');
  });

  it('com o repositório público, o `pnpm publish` leva --provenance', () => {
    const comandos = publicacoesEfetivas(REPO_PUBLICO);
    expect(comandos.length).toBeGreaterThan(0);
    expect(comandos.every((c) => c.includes('--provenance'))).toBe(true);
  });

  it('mantém `id-token: write` no job (trusted publishing por OIDC)', () => {
    expect(jobPublicar.permissions?.['id-token']).toBe('write');
  });
});

describe('.github/workflows/publish.yml — ordem e portão da publicação', () => {
  const indicePublicacao = jobPublicar.steps.findIndex((p) => p.run?.includes('pnpm publish'));

  it('publica na ordem contract → cli → app-kit → create-simplafy-app', () => {
    const run = jobPublicar.steps[indicePublicacao]?.run ?? '';
    const laco = /for\s+pacote\s+in\s+([^;\n]+)/.exec(run);
    expect(laco, 'o passo de publicação precisa iterar os pacotes').not.toBeNull();
    expect(laco![1].trim().split(/\s+/)).toEqual(['contract', 'cli', 'app-kit', 'create-simplafy-app']);
  });

  it('o portão "nenhum tarball leva workspace:" roda antes de publicar e cobre todo pacote que depende por workspace:', () => {
    const indicePortao = jobPublicar.steps.findIndex(
      (p) => p.run?.includes('pnpm pack') && p.run.includes("grep -q 'workspace:'"),
    );
    expect(indicePortao).toBeGreaterThanOrEqual(0);
    expect(indicePortao).toBeLessThan(indicePublicacao);

    const laco = /for\s+pacote\s+in\s+([^;\n]+)/.exec(jobPublicar.steps[indicePortao].run!);
    const cobertos = laco![1].trim().split(/\s+/);
    const comWorkspace = ['contract', 'cli', 'app-kit', 'create-simplafy-app'].filter((nome) =>
      readFileSync(fileURLToPath(new URL(`../packages/${nome}/package.json`, import.meta.url)), 'utf8').includes(
        'workspace:',
      ),
    );
    expect(comWorkspace.length).toBeGreaterThan(0);
    for (const nome of comWorkspace) expect(cobertos).toContain(nome);
  });
});

// O tarball de verdade (`pnpm pack`, quem reescreve `workspace:*`) de cada
// pacote publicável: nada de `workspace:` no package.json empacotado, e todo
// arquivo que `bin`/`main`/`exports` apontam está dentro dele — senão
// `npx @simpla.fy/adk` instala e não acha o executável.
describe.each(['contract', 'cli', 'app-kit', 'create-simplafy-app'] as const)(
  'packages/%s — tarball do pnpm pack',
  (nome) => {
    const dir = fileURLToPath(new URL(`../packages/${nome}`, import.meta.url));
    let destino: string;
    let empacotado: Record<string, unknown>;

    beforeAll(() => {
      destino = mkdtempSync(join(tmpdir(), `adk-pack-${nome}-`));
      // O pnpm que roda a suíte (`npm_execpath`), não o shim do corepack: o
      // setup troca o HOME, o shim não acha o cache e tenta baixar o pnpm.
      const pnpm = process.env.npm_execpath;
      if (!pnpm) throw new Error('rode a suíte por `pnpm test` (npm_execpath ausente)');
      execFileSync(process.execPath, [pnpm, 'pack', '--pack-destination', destino], {
        cwd: dir,
        stdio: 'pipe',
      });
      const [tgz] = readdirSync(destino).filter((f) => f.endsWith('.tgz'));
      execFileSync('tar', ['-xzf', join(destino, tgz), '-C', destino]);
      empacotado = JSON.parse(readFileSync(join(destino, 'package', 'package.json'), 'utf8'));
    });

    afterAll(() => {
      rmSync(destino, { recursive: true, force: true });
    });

    it('o package.json empacotado não leva nenhum `workspace:`', () => {
      expect(JSON.stringify(empacotado)).not.toContain('workspace:');
    });

    it('o tarball contém todo arquivo apontado por bin, main e exports', () => {
      const alvos = new Set<string>();
      const coletar = (v: unknown): void => {
        if (typeof v === 'string') alvos.add(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(coletar);
      };
      coletar(empacotado.bin);
      coletar(empacotado.main);
      coletar(empacotado.types);
      coletar(empacotado.exports);
      expect(alvos.size).toBeGreaterThan(0);
      const ausentes = [...alvos].filter((alvo) => !existsSync(join(destino, 'package', alvo)));
      expect(ausentes).toEqual([]);
    });
  },
);
