import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// A versão que a CLI declara (`adk --version` e o `serverInfo` do `adk
// mcp-server`) é a do `packages/cli/package.json` — a mesma que vai no tarball
// publicado. Literal no código deriva: a 0.2.0 saiu dizendo "0.1.0".

const dirCli = fileURLToPath(new URL('..', import.meta.url));
const pkgCli = JSON.parse(readFileSync(join(dirCli, 'package.json'), 'utf8')) as {
  version: string;
};

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function versaoAnunciadaPeloMcpServer(command: string, args: string[]): Promise<string | undefined> {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env } });
  client = new Client({ name: 'adk-versao-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client.getServerVersion()?.version;
}

describe('versão da CLI — fonte do código', () => {
  it('adk --version imprime a versão do packages/cli/package.json', async () => {
    const resultado = await runCli(['--version']);
    expect(resultado.stdout.trim()).toBe(pkgCli.version);
  });

  it('adk mcp-server se anuncia ao cliente MCP com a versão do packages/cli/package.json', async () => {
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const versao = await versaoAnunciadaPeloMcpServer('npx', ['tsx', bin, 'mcp-server']);
    expect(versao).toBe(pkgCli.version);
  }, 20_000);
});

// O mutante que importa é o literal atualizado à mão ("0.2.0" no lugar de
// "0.1.0"): bate com o package.json de hoje e volta a derivar no próximo
// release. Por isso o `dist/` construído roda ao lado de um package.json com
// outra versão — só quem lê a versão do package.json do pacote acompanha.
describe('versão da CLI — pacote construído (o que o npm instala)', () => {
  const versaoDeOutroRelease = '9.8.7-versao-de-teste';
  let pacote: string;

  beforeAll(() => {
    // Dentro de packages/cli: a resolução de módulos sobe até o node_modules
    // do pacote e acha as dependências (contrato incluso), como no install.
    pacote = mkdtempSync(join(dirCli, '.tmp-versao-'));
    cpSync(join(dirCli, 'dist'), join(pacote, 'dist'), { recursive: true });
    writeFileSync(
      join(pacote, 'package.json'),
      JSON.stringify({ ...pkgCli, version: versaoDeOutroRelease }, null, 2),
    );
  });

  afterAll(() => {
    rmSync(pacote, { recursive: true, force: true });
  });

  it('dist/bin.js --version imprime a versão do package.json que está ao lado do dist', () => {
    const saida = execFileSync(process.execPath, [join(pacote, 'dist/bin.js'), '--version'], {
      encoding: 'utf8',
    });
    expect(saida.trim()).toBe(versaoDeOutroRelease);
  });

  it('dist/bin.js mcp-server se anuncia com a versão do package.json que está ao lado do dist', async () => {
    const versao = await versaoAnunciadaPeloMcpServer(process.execPath, [
      join(pacote, 'dist/bin.js'),
      'mcp-server',
    ]);
    expect(versao).toBe(versaoDeOutroRelease);
  }, 20_000);
});
