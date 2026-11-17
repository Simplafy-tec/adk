import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Ticket 06 (adk-externo) — o plugin vai para um repo PÚBLICO
// (Simplafy-tec/simplafy-adk-plugin), espelhado a partir de `plugin/` deste
// repo. Quem instala é integrador de fora: não pode ler referência interna
// (issue/ticket, observabilidade, cliente, infra) nem URL de staging, e
// precisa de um caminho de início só-produção: login → init org → plan → apply.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = join(ROOT, 'plugin');
const SCRIPT = join(ROOT, 'scripts', 'espelhar-plugin.sh');
const REPO_PUBLICO = 'Simplafy-tec/simplafy-adk-plugin';

const URL_REPO_PUBLICO = `https://github.com/${REPO_PUBLICO}.git`;

function git(dir: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${r.stderr}`);
  return r;
}

// Cria um repo git em `dir` com remote.origin.url = `url` (simula um clone).
function criarCloneGit(dir: string, url: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', url);
}

function espelhar(destino: string) {
  return spawnSync('bash', [SCRIPT, destino], { cwd: ROOT, encoding: 'utf8' });
}

function listarArquivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let arquivos: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) arquivos = arquivos.concat(listarArquivos(caminho));
    else arquivos.push(caminho);
  }
  return arquivos;
}

function ler(caminho: string): string {
  return readFileSync(caminho, 'utf8');
}

function frontmatter(conteudo: string): { name?: string; description?: string } {
  const m = conteudo.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return {
    name: m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim(),
  };
}

/** Corpo da seção cujo título casa `titulo`, até o próximo título de nível igual ou maior. */
function secao(conteudo: string, titulo: RegExp): string | undefined {
  const linhas = conteudo.split('\n');
  const inicio = linhas.findIndex((l) => /^#{1,6}\s/.test(l) && titulo.test(l));
  if (inicio < 0) return undefined;
  const nivel = linhas[inicio].match(/^(#+)/)![1].length;
  const fim = linhas.findIndex(
    (l, i) => i > inicio && /^(#+)\s/.test(l) && l.match(/^(#+)/)![1].length <= nivel,
  );
  return linhas.slice(inicio, fim < 0 ? undefined : fim).join('\n');
}

/** Garante que cada padrão aparece, e na ordem dada (pela 1ª ocorrência). */
function esperarEmOrdem(conteudo: string, padroes: RegExp[]): void {
  let ultimo = -1;
  for (const p of padroes) {
    const idx = conteudo.search(p);
    expect(idx, `${p} não aparece`).toBeGreaterThanOrEqual(0);
    expect(idx, `${p} aparece antes do passo anterior`).toBeGreaterThan(ultimo);
    ultimo = idx;
  }
}

// --- 1. Nada interno no que vai para o repo público --------------------------

// Referências que só fazem sentido dentro da Simplafy. Sem exceção de seção:
// staging se documenta só como `--profile staging`, sem URL.
const PROIBIDOS: Array<[string, RegExp]> = [
  ['issue#N (tracker interno)', /issue#\d/i],
  ['hub# (ticket interno)', /hub#/i],
  ['Langfuse (observabilidade interna)', /langfuse/i],
  ['repo privado simplafy-clientes', /simplafy-clientes/i],
  ['Infisical (cofre interno)', /infisical/i],
  ['kubectl (infra interna)', /kubectl/i],
  ['dev-1 (máquina interna)', /\bdev-1\b/i],
  ['URL de staging', /-staging\.simplafy\.com\.br/i],
];

// Única exceção, funcional e não documental: o hook precisa reconhecer o host
// de staging para ficar em silêncio com `ADK_HUB_URL=<staging> adk apply`
// (contrato já testado em test/plugin.test.ts). Vale só para a URL de staging
// e só no código do hook — comentário com hub#/issue# continua proibido.
const EXCECAO_URL_STAGING = new Set([join(PLUGIN_DIR, 'hooks', 'checar-ambiente.js')]);

// Nomes de cliente NÃO ficam em texto neste repo público: só o sha256 do termo.
// Mesmo critério das regex antigas: sem caixa para dois deles; com caixa exata para os outros três.
// Nomes sem caixa casam como SUBSTRING (como a regex antiga: «Nome2026» e «NomeX» também são achados):
// hash de cada janela, em minúsculas, com o comprimento do termo. Os de caixa exata casam só como palavra.
const HASH_CLIENTE_SEM_CAIXA = new Map<number, string>([
  [6, 'd1bdb61bca284fe97aef81f9721d3ab0c220b4a0b296523b59207a8d84165e23'],
  [7, 'b5cf71de325662438357c96d33e7d850e298b1f70f7939458bd835912bc9c2a7'],
]);
const HASH_CLIENTE_EXATO = new Set([
  '797e95388d3d118cd118bfbc6a18bfd526e57f37a886d88ccd1ca8a32bbb634a',
  '861d2eb0996f7ccedf00dfd5e8cf426db809485e73055c8897327a5aa25653ba',
  '36120f0385213e4db93af071cb5c0513a8b960c80103ba6984f339baf1af8c0e',
]);
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export function citaCliente(conteudo: string): boolean {
  for (const [palavra] of conteudo.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (HASH_CLIENTE_EXATO.has(sha(palavra))) return true;
  }
  const baixo = conteudo.toLowerCase();
  for (const [tam, hash] of HASH_CLIENTE_SEM_CAIXA) {
    for (let i = 0; i + tam <= baixo.length; i++) {
      if (sha(baixo.slice(i, i + tam)) === hash) return true;
    }
  }
  return false;
}

function violacoes(arquivos: string[], base: string): string[] {
  const achados: string[] = [];
  for (const arquivo of arquivos) {
    const conteudo = ler(arquivo);
    if (citaCliente(conteudo)) achados.push(`${relative(base, arquivo)}: nome de cliente`);
    for (const [rotulo, padrao] of PROIBIDOS) {
      if (rotulo === 'URL de staging' && EXCECAO_URL_STAGING.has(arquivo)) continue;
      if (padrao.test(conteudo)) achados.push(`${relative(base, arquivo)}: ${rotulo}`);
    }
  }
  return achados;
}

describe('guarda de nomes de cliente (por hash)', () => {
  // Os nomes não ficam em texto: montados ao contrário a partir de pedaços.
  const inverso = (t: string) => [...t].reverse().join('');
  const sem = [inverso('xelfinu'), inverso('lasarb')];
  const exato = [inverso('ANC'), inverso('élO')];

  it.each([...sem, ...sem.map((n) => n.toUpperCase())])('acha o nome #%# solto, colado e em camelCase', (n) => {
    expect(citaCliente(`x ${n} y`)).toBe(true);
    expect(citaCliente(`${n}2026`)).toBe(true);
    expect(citaCliente(`pre${n}X`)).toBe(true);
    expect(citaCliente(`${n}CadernoEnabled`)).toBe(true);
  });

  it.each(exato)('acha o nome exato #%# como palavra', (n) => {
    expect(citaCliente(`o cliente ${n}.`)).toBe(true);
  });

  it('texto limpo passa', () => {
    expect(citaCliente('uma org de exemplo chamada acme, agente Ana')).toBe(false);
  });
});

describe('plugin/ não cita nada interno da Simplafy', () => {
  it('nenhum arquivo (skills, README, QUICKSTART, hooks, manifestos) tem referência interna', () => {
    const arquivos = listarArquivos(PLUGIN_DIR);
    expect(arquivos.length).toBeGreaterThan(0);
    expect(violacoes(arquivos, ROOT)).toEqual([]);
  });

  it('staging só aparece como `--profile staging` nos documentos (nenhum host de staging)', () => {
    const docs = listarArquivos(PLUGIN_DIR).filter((f) => f.endsWith('.md'));
    const conteudo = docs.map(ler).join('\n');
    expect(conteudo).not.toMatch(/staging\.[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it('plugin.json aponta para o repo público, não para o repo privado do ADK', () => {
    const manifesto = JSON.parse(ler(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')));
    for (const campo of ['homepage', 'repository'] as const) {
      const valor = String(manifesto[campo] ?? '');
      expect(valor, campo).toContain(REPO_PUBLICO);
    }
    expect(JSON.stringify(manifesto)).not.toMatch(/Simplafy-tec\/simplafy-adk(?!-plugin)/);
  });
});

// --- 2. Skill de início, só-produção ----------------------------------------

describe('plugin/skills/adk-comecar/SKILL.md', () => {
  const caminho = join(PLUGIN_DIR, 'skills', 'adk-comecar', 'SKILL.md');

  it('existe com frontmatter válido (name = diretório, description com "Use quando")', () => {
    const fm = frontmatter(ler(caminho));
    expect(fm.name).toBe('adk-comecar');
    expect(fm.description).toBeTruthy();
    expect(fm.description).toMatch(/Use quando/);
  });

  it('cobre, nesta ordem, adk login → adk init org → adk plan → adk apply', () => {
    esperarEmOrdem(ler(caminho), [/adk login\b/, /adk init org\b/, /adk plan\b/, /adk apply\b/]);
  });

  it('avisa que apply em produção pede confirmação e que --yes a pula (fora de terminal)', () => {
    const conteudo = ler(caminho);
    expect(conteudo).toMatch(/produ[çc][ãa]o/i);
    expect(conteudo).toMatch(/confirma/i);
    expect(conteudo).toMatch(/--yes/);
  });

  it('está registrada no plugin.json', () => {
    const manifesto = JSON.parse(ler(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')));
    const nomes = (manifesto.skills as string[]).map((c) => c.replace(/^\.\/?skills\//, ''));
    expect(nomes).toContain('adk-comecar');
  });
});

// --- 3. O que depende da Simplafy -------------------------------------------

it('alguma página do plugin tem a seção "o que depende da Simplafy" com tools-gateway, satélite MCP e app adopt', () => {
  const docs = listarArquivos(PLUGIN_DIR).filter((f) => f.endsWith('.md'));
  const secoes = docs
    .map((f) => secao(ler(f), /depende da Simplafy/i))
    .filter((s): s is string => Boolean(s));
  expect(secoes.length, 'nenhum título "... depende da Simplafy" em plugin/**/*.md').toBeGreaterThan(0);
  const corpo = secoes.join('\n');
  expect(corpo).toMatch(/tools-gateway/);
  expect(corpo).toMatch(/sat[ée]lite/i);
  expect(corpo).toMatch(/\bMCP\b/);
  expect(corpo).toMatch(/app adopt/);
});

// --- 4. QUICKSTART -----------------------------------------------------------

describe('plugin/QUICKSTART.md', () => {
  const caminho = join(PLUGIN_DIR, 'QUICKSTART.md');

  it('instala a CLI pelo npm e o plugin pelo marketplace público, depois login → init org → plan → apply', () => {
    esperarEmOrdem(ler(caminho), [
      /npm (i|install) (-g|--global) @simpla\.fy\/adk\b|npx (-y )?@simpla\.fy\/adk\b/,
      new RegExp(`/plugin marketplace add ${REPO_PUBLICO}\\b`),
      /adk login\b/,
      /adk init org\b/,
      /adk plan\b/,
      /adk apply\b/,
    ]);
  });

  it('tem seção de erros comuns com exit 2 por falta de --yes e por --env divergente', () => {
    const corpo = secao(ler(caminho), /erros comuns/i);
    expect(corpo, 'falta título "Erros comuns"').toBeDefined();
    expect(corpo).toMatch(/exit 2|c[óo]digo 2|sai com 2/i);
    expect(corpo).toMatch(/--yes/);
    expect(corpo).toMatch(/--env/);
    expect(corpo).toMatch(/divergen/i);
  });

  it('o README do plugin aponta para o QUICKSTART', () => {
    expect(ler(join(PLUGIN_DIR, 'README.md'))).toMatch(/QUICKSTART\.md/);
  });
});

// --- 5/6. Espelhamento para o repo público ---------------------------------

describe('scripts/espelhar-plugin.sh (modo seco: só copia para um diretório)', () => {
  let destino: string;
  let execucao: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    destino = mkdtempSync(join(tmpdir(), 'espelho-plugin-'));
    // Simula um clone já existente do repo público (git de verdade, com o
    // remote origin do repo público): .git fica, lixo antigo sai.
    criarCloneGit(destino, URL_REPO_PUBLICO);
    mkdirSync(join(destino, 'plugin', 'skills', 'skill-removida'), { recursive: true });
    writeFileSync(join(destino, 'plugin', 'skills', 'skill-removida', 'SKILL.md'), 'velho\n');
    execucao = spawnSync('bash', [SCRIPT, destino], { cwd: ROOT, encoding: 'utf8' });
  });

  afterAll(() => {
    if (destino) rmSync(destino, { recursive: true, force: true });
  });

  it('o script existe e não faz git push/commit (publicar é passo separado)', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(ler(SCRIPT)).not.toMatch(/\bgit\s+(push|commit)\b/);
  });

  it('sem diretório destino, falha com código diferente de zero', () => {
    const r = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });

  it('roda com sucesso apontando para um diretório temporário', () => {
    expect(execucao.status, String(execucao.stderr)).toBe(0);
  });

  it('copia plugin/ inteiro, byte a byte', () => {
    const origem = listarArquivos(PLUGIN_DIR);
    expect(origem.length).toBeGreaterThan(0);
    for (const arquivo of origem) {
      const alvo = join(destino, 'plugin', relative(PLUGIN_DIR, arquivo));
      expect(existsSync(alvo), relative(ROOT, arquivo)).toBe(true);
      expect(readFileSync(alvo).equals(readFileSync(arquivo)), relative(ROOT, arquivo)).toBe(true);
    }
  });

  it('é espelho: arquivo que não existe mais em plugin/ some do destino, e .git fica', () => {
    expect(existsSync(join(destino, 'plugin', 'skills', 'skill-removida'))).toBe(false);
    expect(existsSync(join(destino, '.git', 'HEAD'))).toBe(true);
  });

  it('copia LICENSE igual ao da raiz', () => {
    expect(ler(join(destino, 'LICENSE'))).toBe(ler(join(ROOT, 'LICENSE')));
  });

  it('não copia nada além de plugin/, .claude-plugin/marketplace.json, LICENSE e README.md', () => {
    const permitidos = new Set(['.git', '.claude-plugin', 'plugin', 'LICENSE', 'README.md']);
    expect(readdirSync(destino).filter((e) => !permitidos.has(e))).toEqual([]);
    expect(readdirSync(join(destino, '.claude-plugin'))).toEqual(['marketplace.json']);
    for (const pasta of ['packages', 'services', 'templates', 'test', 'scripts', 'node_modules']) {
      expect(existsSync(join(destino, pasta)), pasta).toBe(false);
    }
  });

  it('marketplace.json do espelho é válido e aponta para ./plugin, com o mesmo nome/versão do plugin.json', () => {
    const marketplace = JSON.parse(ler(join(destino, '.claude-plugin', 'marketplace.json')));
    const plugin = JSON.parse(ler(join(destino, 'plugin', '.claude-plugin', 'plugin.json')));
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const entrada = marketplace.plugins[0];
    expect(entrada.source).toBe('./plugin');
    expect(existsSync(resolve(destino, entrada.source, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(entrada.name).toBe(plugin.name);
    if (entrada.version !== undefined) expect(entrada.version).toBe(plugin.version);
    expect(plugin.name).toBeTruthy();
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin.description).toBeTruthy();
  });

  it('cada skill listada no plugin.json do espelho existe no espelho', () => {
    const plugin = JSON.parse(ler(join(destino, 'plugin', '.claude-plugin', 'plugin.json')));
    for (const caminho of plugin.skills as string[]) {
      expect(existsSync(resolve(destino, 'plugin', caminho, 'SKILL.md')), caminho).toBe(true);
    }
  });

  it('nada no espelho (fora de .git) tem referência interna', () => {
    const arquivos = listarArquivos(destino).filter((f) => !relative(destino, f).startsWith('.git'));
    const espelhoDoHook = join(destino, 'plugin', 'hooks', 'checar-ambiente.js');
    const achados = violacoes(
      arquivos.filter((f) => f !== espelhoDoHook),
      destino,
    );
    // o hook espelhado segue a mesma exceção do original (só a URL de staging)
    if (existsSync(espelhoDoHook)) {
      const conteudo = ler(espelhoDoHook);
      for (const [rotulo, padrao] of PROIBIDOS) {
        if (rotulo !== 'URL de staging' && padrao.test(conteudo)) achados.push(`hook: ${rotulo}`);
      }
    }
    expect(achados).toEqual([]);
  });
});

// --- Trava de destino: o espelho apaga tudo menos .git, então só pode rodar
// num clone do repo público ou num diretório vazio/inexistente.

describe('scripts/espelhar-plugin.sh: trava de destino', () => {
  const temporarios: string[] = [];
  const novoTemp = () => {
    const d = mkdtempSync(join(tmpdir(), 'espelho-trava-'));
    temporarios.push(d);
    return d;
  };

  afterAll(() => {
    for (const d of temporarios) rmSync(d, { recursive: true, force: true });
  });

  function fotografar(dir: string): Record<string, string> {
    const foto: Record<string, string> = {};
    for (const f of listarArquivos(dir)) foto[relative(dir, f)] = readFileSync(f).toString('base64');
    return foto;
  }

  it('destino não vazio que não é repo git: sai com 2 e não toca em nada', () => {
    const destino = novoTemp();
    mkdirSync(join(destino, 'docs'));
    writeFileSync(join(destino, 'docs', 'importante.md'), 'não apagar\n');
    writeFileSync(join(destino, 'notas.txt'), 'trabalho do usuário\n');
    const antes = fotografar(destino);

    const r = espelhar(destino);

    expect(r.status, String(r.stderr)).toBe(2);
    expect(String(r.stderr)).not.toBe('');
    expect(fotografar(destino)).toEqual(antes);
    expect(existsSync(join(destino, 'plugin'))).toBe(false);
  });

  it('destino não vazio com .git sem remote origin: sai com 2 e não toca em nada', () => {
    const destino = novoTemp();
    git(destino, 'init', '-q');
    writeFileSync(join(destino, 'notas.txt'), 'trabalho do usuário\n');
    const antes = fotografar(destino);

    const r = espelhar(destino);

    expect(r.status, String(r.stderr)).toBe(2);
    expect(fotografar(destino)).toEqual(antes);
  });

  it('destino não vazio clone de OUTRO repo: sai com 2 e não toca em nada', () => {
    const destino = novoTemp();
    criarCloneGit(destino, 'https://github.com/Simplafy-tec/outro-repo.git');
    writeFileSync(join(destino, 'README.md'), 'outro projeto\n');
    mkdirSync(join(destino, 'src'));
    writeFileSync(join(destino, 'src', 'index.ts'), 'export {};\n');
    const antes = fotografar(destino);

    const r = espelhar(destino);

    expect(r.status, String(r.stderr)).toBe(2);
    expect(fotografar(destino)).toEqual(antes);
  });

  it('destino vazio: espelha normalmente', () => {
    const destino = novoTemp();
    const r = espelhar(destino);
    expect(r.status, String(r.stderr)).toBe(0);
    expect(existsSync(join(destino, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(destino, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(destino, 'LICENSE'))).toBe(true);
    expect(existsSync(join(destino, 'README.md'))).toBe(true);
  });

  it('destino inexistente: cria e espelha normalmente', () => {
    const destino = join(novoTemp(), 'ainda', 'nao', 'existe');
    const r = espelhar(destino);
    expect(r.status, String(r.stderr)).toBe(0);
    expect(existsSync(join(destino, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(destino, 'LICENSE'))).toBe(true);
  });

  it('clone do simplafy-adk-plugin com arquivos velhos: espelha, remove os velhos e preserva .git', () => {
    const destino = novoTemp();
    criarCloneGit(destino, URL_REPO_PUBLICO);
    writeFileSync(join(destino, 'arquivo-velho.txt'), 'velho\n');
    mkdirSync(join(destino, 'plugin', 'skills', 'skill-antiga'), { recursive: true });
    writeFileSync(join(destino, 'plugin', 'skills', 'skill-antiga', 'SKILL.md'), 'velho\n');

    const r = espelhar(destino);

    expect(r.status, String(r.stderr)).toBe(0);
    expect(existsSync(join(destino, 'arquivo-velho.txt'))).toBe(false);
    expect(existsSync(join(destino, 'plugin', 'skills', 'skill-antiga'))).toBe(false);
    expect(existsSync(join(destino, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(destino, '.git', 'HEAD'))).toBe(true);
    expect(git(destino, 'config', '--get', 'remote.origin.url').stdout.trim()).toBe(URL_REPO_PUBLICO);
  });

  it('clone via SSH (git@github.com:...simplafy-adk-plugin.git) também é aceito', () => {
    const destino = novoTemp();
    criarCloneGit(destino, `git@github.com:${REPO_PUBLICO}.git`);
    writeFileSync(join(destino, 'arquivo-velho.txt'), 'velho\n');

    const r = espelhar(destino);

    expect(r.status, String(r.stderr)).toBe(0);
    expect(existsSync(join(destino, 'arquivo-velho.txt'))).toBe(false);
    expect(existsSync(join(destino, '.git', 'HEAD'))).toBe(true);
  });
});
