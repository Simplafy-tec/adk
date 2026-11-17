import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { API_PROD } from './hub-prod-falso.js';

// Sem ADK_HUB_URL o build consulta a política do Hub de PRODUÇÃO: aqui ela é
// falsa (404 ⇒ política embutida). O Hub `.test` serve uma política com teto
// de pacote minúsculo, para provar que o portão de tamanho também julga o
// componente Node.
const HUB_TETO_BAIXO = 'http://hub-teto-baixo.test';
const server = setupServer(
  http.get(`${API_PROD}/api/v1/adk/policy`, () => new HttpResponse(null, { status: 404 })),
  http.get(`${HUB_TETO_BAIXO}/api/v1/adk/policy`, () =>
    HttpResponse.json({
      spec_versions: ['v1'],
      runtimes: { node: '>=20', python: ['3.12'], uv: '>=0.4' },
      limits: { script: { cpu: 1, memory: 512, timeout: 60 }, mcp: {}, app: {}, org: {}, node: {} },
      registries: { allowed_images: [] },
      package: { max_size_bytes: 200 },
    }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Hub#2.6.26.4, item 4/7 do brief — `adk build` de um componente Node NUNCA
// pode sair com `checks[]` contendo só `{nome:'tamanho'}` (o "portão mudo" que
// hoje acontece porque `if (existsSync(pyproject.toml))` é a única entrada de
// runtime). O espelho exato da lição paga em `test/init.test.ts`: o servidor
// gerado importa uma dependência que o manifesto de pacote não declara.

describe('adk build — componente Node (portão de runtime, item 4/7)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-mcp-node-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('init --runtime node → build: exit 0 no esqueleto recém-gerado, SEM node_modules', async () => {
    const alvo = join(dir, 'satelite-node');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node', '--dir', alvo], {
      cwd: dir,
    });
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).toBe(0);
  });

  it('checks[] do componente Node NÃO é só `tamanho` — existe uma entrada de portão de runtime Node', async () => {
    const alvo = join(dir, 'satelite-node-2');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-2', '--dir', alvo], {
      cwd: dir,
    });
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { checks: { nome: string }[] };
    expect(parsed.checks.map((c) => c.nome)).not.toEqual(['tamanho']);
    expect(parsed.checks.length).toBeGreaterThan(1);
  });

  it('mantém contrato.parcial (kind: mcp é julgado pelo apply do Hub, não pelo contrato público) com `image` obrigatório', async () => {
    const alvo = join(dir, 'satelite-node-3');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-3', '--dir', alvo], {
      cwd: dir,
    });
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as {
      contrato?: { parcial: boolean; campos_obrigatorios: { campo: string }[] };
    };
    expect(parsed.contrato?.parcial).toBe(true);
    expect(parsed.contrato?.campos_obrigatorios.map((c) => c.campo)).toContain('image');
  });

  it('dependência importada e NÃO declarada no package.json reprova com exit 1 e `detalhe` legível', async () => {
    const alvo = join(dir, 'satelite-node-4');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-4', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    // Import de um pacote público que NÃO está (e não deveria estar) em
    // nenhum package.json gerado pelo template.
    writeFileSync(join(alvo, 'src', 'server.ts'), `import 'left-pad';\n${server}`);

    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { checks: { nome: string; ok: boolean; detalhe?: string }[] };

    expect(result.exitCode).toBe(1);
    const reprovado = parsed.checks.find((c) => !c.ok);
    expect(reprovado).toBeDefined();
    expect(reprovado?.detalhe).toBeTruthy();
    expect(reprovado?.detalhe?.toLowerCase()).toContain('left-pad');
  });

  it('segredo literal plantado num .ts do componente Node reprova com secret_literal (mutation check do scanLeaks)', async () => {
    const alvo = join(dir, 'satelite-node-5');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-5', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    writeFileSync(
      join(alvo, 'src', 'server.ts'),
      `${server}\nconst chaveDeExemploQueNuncaDeveriaEstarAqui = "sk-abcdefgh12345678";\n`,
    );

    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { issues: { code: string }[] };
    expect(result.exitCode).toBe(1);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('CPF plantado num .ts do componente Node reprova com pii_in_config', async () => {
    const alvo = join(dir, 'satelite-node-6');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-6', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    writeFileSync(join(alvo, 'src', 'server.ts'), `${server}\nconst cpfDeTeste = '123.456.789-09';\n`);

    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { issues: { code: string; path: string }[] };
    expect(result.exitCode).toBe(1);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'pii_in_config' }));
  });

  it('id interno (cuid) plantado num .ts do componente Node reprova com internal_id apontando o arquivo', async () => {
    const alvo = join(dir, 'satelite-node-7');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-7', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    writeFileSync(
      join(alvo, 'src', 'server.ts'),
      `${server}\nconst orgFixa = 'cmublmi3402qqev01jkna0yw6';\n`,
    );

    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { issues: { code: string; path: string }[] };
    expect(result.exitCode).toBe(1);
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: 'internal_id', path: join('src', 'server.ts') }),
    );
  });

  it('o esqueleto Node recém-gerado NÃO acusa vazamento nenhum (issues vazio)', async () => {
    const alvo = join(dir, 'satelite-node-8');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-8', '--dir', alvo], {
      cwd: dir,
    });
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    const parsed = JSON.parse(result.stdout) as { issues: { code: string }[] };
    expect(parsed.issues).toEqual([]);
  });

  it('pacote Node acima do teto da política reprova com package_too_large', async () => {
    const alvo = join(dir, 'satelite-node-9');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-9', '--dir', alvo], {
      cwd: dir,
    });
    const result = await runCli(['build', '--dir', alvo], {
      cwd: dir,
      env: { ADK_HUB_URL: HUB_TETO_BAIXO },
    });
    const parsed = JSON.parse(result.stdout) as { issues: { code: string }[] };
    expect(result.exitCode).toBe(1);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'package_too_large' }));
  });

  it('import de builtin do Node (com e sem `node:`) e import relativo NÃO reprovam o portão de dependências', async () => {
    const alvo = join(dir, 'satelite-node-10');
    await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node-10', '--dir', alvo], {
      cwd: dir,
    });
    const server = readFileSync(join(alvo, 'src', 'server.ts'), 'utf8');
    writeFileSync(join(alvo, 'src', 'util.ts'), 'export const um = 1;\n');
    writeFileSync(
      join(alvo, 'src', 'server.ts'),
      `import { readFileSync as _ler } from 'node:fs';\nimport { join as _j } from 'path';\nimport { um as _um } from './util.js';\n${server}`,
    );
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).toBe(0);
  });
});

describe('adk build — portão de dependências do componente Node: bordas', () => {
  let dir: string;
  let alvo: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-mcp-node-borda-'));
    alvo = join(dir, 'satelite-node');
    const init = await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node', '--dir', alvo], { cwd: dir });
    expect(init.exitCode).toBe(0);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type Saida = { checks: { nome: string; ok: boolean; detalhe?: string }[] };
  const checkDeps = (saida: Saida) => saida.checks.find((c) => c.nome === 'dependências node');

  async function build(): Promise<{ exitCode: number; parsed: Saida }> {
    const result = await runCli(['build', '--dir', alvo], { cwd: dir });
    // O contrato da saída é JSON — exceção crua aqui é falha do portão.
    return { exitCode: result.exitCode, parsed: JSON.parse(result.stdout) as Saida };
  }

  function prefixarServer(linhas: string): void {
    const caminho = join(alvo, 'src', 'server.ts');
    writeFileSync(caminho, `${linhas}\n${readFileSync(caminho, 'utf8')}`);
  }

  it('package.json malformado ⇒ saída no contrato JSON, `dependências node` ok:false com "package.json inválido", exit 1', async () => {
    writeFileSync(join(alvo, 'package.json'), '{ "name": "satelite-node", ');
    const { exitCode, parsed } = await build();
    expect(exitCode).toBe(1);
    const deps = checkDeps(parsed);
    expect(deps?.ok).toBe(false);
    expect(deps?.detalhe).toContain('package.json inválido');
  });

  it.each([
    ['`null`', 'null'],
    ['número', '42'],
    ['lista', '[]'],
    ['string', '"x"'],
  ])(
    'package.json %s ⇒ saída no contrato JSON, `dependências node` ok:false com "package.json inválido", exit 1',
    async (_rotulo, conteudo) => {
      // JSON válido que não é objeto: `JSON.parse` aceita. `null` estourava como
      // exceção crua (sem JSON no stdout); número, lista e string passavam no portão.
      writeFileSync(join(alvo, 'package.json'), `${conteudo}\n`);
      const result = await runCli(['build', '--dir', alvo], { cwd: dir });
      expect(result.stdout, `stdout vazio; stderr: ${result.stderr}`).not.toBe('');
      const parsed = JSON.parse(result.stdout) as Saida;
      expect(result.exitCode).toBe(1);
      const deps = checkDeps(parsed);
      expect(deps?.ok).toBe(false);
      expect(deps?.detalhe).toContain('package.json inválido');
    },
  );

  it.each([
    ['`/*` dentro de string', "const _entrada = 'src/*';", "const _saida = 'dist/**/x.js';"],
    ['`//` dentro de string', "const _prefixo = '//cdn.exemplo';", ''],
  ])(
    'marcador de comentário %s não esconde import NÃO declarado na mesma região',
    async (_rotulo, antes, depois) => {
      // O import fica entre/depois do marcador: tratar o marcador da string como
      // comentário apagava o import e o portão passava calado (falso negativo).
      prefixarServer(`${antes} const _carregar = async () => await import('left-pad');\n${depois}`);
      const { exitCode, parsed } = await build();
      expect(checkDeps(parsed)?.ok).toBe(false);
      expect(checkDeps(parsed)?.detalhe).toContain('left-pad');
      expect(exitCode).toBe(1);
    },
  );

  /** Um arquivo-fonte inteiro sob controle do teste (o `server.ts` do template tem JSDoc com `*\/`). */
  function escreverFonte(conteudo: string): void {
    writeFileSync(join(alvo, 'src', 'extra.ts'), conteudo);
  }

  const IMPORT_NAO_DECLARADO = "import leftPad from 'left-pad';";
  // Um `*/` mais adiante no MESMO arquivo: o falso comentário iria até ele, não até o EOF.
  const JSDOC_ADIANTE = '/** Documentação de exemplo. */\nexport const fim = leftPad;\n';

  /** `expr` seguido de template multilinha, de template com URL e de `import()` na mesma linha da URL. */
  const divisaoComTemplate = (expr: string): string =>
    `${expr} + \`início\nfim\`;\n` +
    "export const url = `https://cdn.exemplo/x`; export const carregar = () => import('left-pad');\n";

  // Literal de regex com `/*`, `//`, aspa ou crase era lido como comentário ou
  // string e apagava o import seguinte: o portão passava calado (falso negativo).
  // Cada caso roda sem `*/` adiante (esconderia até o EOF) e com um JSDoc
  // adiante (esconderia até o próximo `*/`).
  const LITERAIS_QUE_ESCONDIAM_IMPORT: [string, string][] = [
    ['regex `/\\/*$/` (tirar barras finais)', `export const limpar = (u: string) => u.replace(/\\/*$/, '');\n${IMPORT_NAO_DECLARADO}\n`],
    ['regex `/[/*]/`', `export const glob = /[/*]/;\n${IMPORT_NAO_DECLARADO}\n`],
    ['regex terminando em `//` com o import na mesma linha', `export const ehUrl = /^https?:\\/\\//; ${IMPORT_NAO_DECLARADO}\n`],
    ['regex com aspa `/\'/` e `\'src/*\'` adiante', `export const aspa = /'/, glob = 'src/*';\n${IMPORT_NAO_DECLARADO}\n`],
    ['regex com crase e template com URL adiante', "export const crase = /`/;\nexport const url = `https://exemplo.test/x`; " + `${IMPORT_NAO_DECLARADO}\n`],
    ['template multilinha com `${"`"}`', 'export const t = `l1\n${"`"}\nl3 http://x\n`;\nexport const glob = `src/*`;\n' + `${IMPORT_NAO_DECLARADO}\n`],
    // Divisão lida como regex: o `/` engole o resto da linha, inclusive uma
    // crase (ou o `}` de um `${}`), e a paridade de template inverte — o texto
    // de um template adiante vira código e o `//` da URL apaga o `import()`.
    ['divisão depois de `x++` com template multilinha', divisaoComTemplate('let x = 1;\nexport const a = x++ / 2')],
    ['divisão depois de `x--` com template multilinha', divisaoComTemplate('let x = 1;\nexport const a = x-- / 2')],
    ['non-null do TS `x! / y` com template multilinha', divisaoComTemplate('declare const x: number | undefined;\ndeclare const y: number;\nexport const a = x! / y')],
    ['non-null do TS `foo()! / 2` com template multilinha', divisaoComTemplate('declare function foo(): number | undefined;\nexport const a = foo()! / 2')],
    ['non-null do TS `arr[0]! / 2` com template multilinha', divisaoComTemplate('declare const arr: (number | undefined)[];\nexport const a = arr[0]! / 2')],
    ['non-null do TS `x! / y` dentro de `${}`', 'declare const x: number | undefined;\ndeclare const y: number;\nexport const a = `${x! / y}\n`;\n' + "export const url = `https://cdn.exemplo/x`; export const carregar = () => require('left-pad');\n"],
    ['`usados! / limite` em `${}` seguido de glob, `import()` e JSDoc (medido de ponta a ponta)', 'export function pct(usados: number | undefined, limite: number): string {\n  return `${Math.round((usados! / limite) * 100)}%`;\n}\nexport const padrao = `dados/*.json`;\nexport const carregar = () => import("left-pad");\n/** Documentação de exemplo. */\nexport const fim = 1;\n'],
    ['palavra-chave como propriedade `obj.of / 2` com template multilinha', divisaoComTemplate('declare const obj: { of: number };\nexport const a = obj.of / 2')],
    ['`export default /\\/*$/` com JSDoc adiante', "export default /\\/*$/;\nexport const carregar = () => import('left-pad');\n/** Documentação de exemplo. */\nexport const fim = 1;\n"],
  ];

  describe.each([
    ['sem `*/` adiante', ''],
    ['com JSDoc `*/` adiante', JSDOC_ADIANTE],
  ])('literal de regex/template que escondia import — %s', (_variante, sufixo) => {
    it.each(LITERAIS_QUE_ESCONDIAM_IMPORT)('%s: o import NÃO declarado é acusado', async (_rotulo, fonte) => {
      escreverFonte(`${fonte}${sufixo}`);
      const { exitCode, parsed } = await build();
      expect(checkDeps(parsed)?.ok, 'o portão aprovou com left-pad não declarado').toBe(false);
      expect(checkDeps(parsed)?.detalhe).toContain('left-pad');
      expect(exitCode).toBe(1);
    });
  });

  it('`/*` sem `*/` adiante não é comentário até o EOF: o import seguinte é acusado', async () => {
    // Código válido nunca tem comentário de bloco sem fechamento — esse `/*` é
    // falso positivo de comentário e não pode engolir o resto do arquivo.
    escreverFonte(`export const x = 1; /* sem fechamento\n${IMPORT_NAO_DECLARADO}\nexport const y = leftPad;\n`);
    const { exitCode, parsed } = await build();
    expect(checkDeps(parsed)?.ok, 'o portão aprovou com left-pad não declarado').toBe(false);
    expect(checkDeps(parsed)?.detalhe).toContain('left-pad');
    expect(exitCode).toBe(1);
  });

  it.each([
    ['URL `http://` dentro de string', `export const u = 'http://cdn.exemplo'; ${IMPORT_NAO_DECLARADO}\n`],
    ['template com `${}` e crase aninhada', "export const t = `a ${Math.random() > 0.5 ? `x` : 'y'} c`;\n" + `${IMPORT_NAO_DECLARADO}\n`],
    ['comentários com aspas desbalanceadas', `// don't\n/* it's " \` */\n${IMPORT_NAO_DECLARADO}\n`],
    ['divisão seguida de comentário de linha', `export const r = 4 / 2; // metade\n${IMPORT_NAO_DECLARADO}\n`],
  ])('guarda — %s: o import NÃO declarado continua acusado', async (_rotulo, fonte) => {
    escreverFonte(fonte);
    const { exitCode, parsed } = await build();
    expect(checkDeps(parsed)?.ok).toBe(false);
    expect(checkDeps(parsed)?.detalhe).toContain('left-pad');
    expect(exitCode).toBe(1);
  });

  it('guarda — o portão ainda enxerga os imports do template: sem o SDK MCP no package.json, acusa só ele', async () => {
    const pkgPath = join(alvo, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> };
    delete pkg.dependencies['@modelcontextprotocol/sdk'];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const { exitCode, parsed } = await build();
    expect(exitCode).toBe(1);
    expect(checkDeps(parsed)?.detalhe).toBe(
      'Import(s) não declarado(s) no package.json: @modelcontextprotocol/sdk',
    );
  });

  it('import em linha de COMENTÁRIO não acusa dependência não declarada', async () => {
    prefixarServer("// import leftPad from 'left-pad';\n/* import x from 'is-odd'; */");
    const { exitCode, parsed } = await build();
    expect(checkDeps(parsed)?.ok, checkDeps(parsed)?.detalhe).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('subpath import `#interno` (campo `imports` do package.json) não acusa', async () => {
    const pkgPath = join(alvo, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, imports: { '#interno': './src/util.ts' } }, null, 2));
    writeFileSync(join(alvo, 'src', 'util.ts'), 'export const um = 1;\n');
    prefixarServer("import { um as _um } from '#interno';");
    const { exitCode, parsed } = await build();
    expect(checkDeps(parsed)?.ok, checkDeps(parsed)?.detalhe).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("`await import('pkg')` dinâmico de pacote NÃO declarado acusa, com o nome no detalhe", async () => {
    prefixarServer("const _carregar = async () => await import('left-pad');");
    const { exitCode, parsed } = await build();
    expect(exitCode).toBe(1);
    expect(checkDeps(parsed)?.ok).toBe(false);
    expect(checkDeps(parsed)?.detalhe).toContain('left-pad');
  });
});
