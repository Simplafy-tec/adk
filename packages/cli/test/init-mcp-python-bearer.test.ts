import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// issue#2848 — o esqueleto Python de `kind: mcp` nasce EXIGINDO credencial.
//
// O primeiro satélite de cliente subiu com FastMCP puro, sem validação de
// Bearer, e ficou respondendo `initialize`/`tools/list` a qualquer um na
// internet — com tools que escreviam no CRM de produção do cliente usando a
// credencial que vive no pod. O registro no Hub envia `Authorization`, mas
// header enviado não é header conferido.
//
// O COMPORTAMENTO (503 sem token, 401 anônimo, 401 bearer errado, 200 com
// bearer correto, `/health` sempre 200) foi provado contra a lib real antes
// deste commit — ver a mensagem do commit. Aqui guardamos o CONTRATO do
// esqueleto: que ele não volte a nascer aberto.

describe('adk init mcp (python) — esqueleto fail-closed (issue#2848)', () => {
  let dir: string;
  let alvo: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-mcp-py-'));
    alvo = join(dir, 'satelite-exemplo');
    await runCli(['init', 'mcp', 'satelite-exemplo', '--dir', alvo], { cwd: dir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const server = () => readFileSync(join(alvo, 'server.py'), 'utf8');

  it('exige credencial: 503 sem MCP_TOKEN e 401 sem Bearer correto', () => {
    const src = server();
    expect(src).toContain('MCP_TOKEN');
    expect(src).toContain('status_code=503');
    expect(src).toContain('status_code=401');
    expect(src).toContain('www-authenticate');
  });

  it('compara o token em tempo constante — `==` vaza o prefixo correto pelo tempo', () => {
    expect(server()).toContain('hmac.compare_digest');
  });

  it('`/health` fica FORA da exigência (readiness e liveness do chart apontam para lá)', () => {
    expect(server()).toMatch(/aberto=\(\s*"\/health"/);
  });

  it('o app exportado é o PROTEGIDO, não o do FastMCP cru', () => {
    const src = server();
    expect(src).toMatch(/app = ExigirBearer\(/);
    // Mutação que este caso pega: exportar `_base` direto deixa o satélite
    // aberto com o middleware presente, porém não montado.
    expect(src).not.toMatch(/^app = _base$/m);
  });

  // Hub#2.6.26.4, dev note do 1º satélite real: o default loopback fez o pod
  // subir com a probe falhando e o log mudo. O bind é 0.0.0.0 EXPLÍCITO no
  // esqueleto (BIND_ADDRESS só sobrescreve); quem protege o satélite é o
  // Bearer obrigatório acima, não o loopback. A prova de runtime (porta em
  // escuta em todas as interfaces) está em `mcp-python-server.test.ts`.
  it('abre em 0.0.0.0 por default — loopback é o defeito do 1º satélite real', () => {
    const src = server();
    expect(src).toContain('BIND_ADDRESS');
    expect(src).toContain('"0.0.0.0"');
    expect(src).not.toContain('"127.0.0.1"');
  });

  it('declara uvicorn: o __main__ passou a servir HTTP, não stdio', () => {
    expect(readFileSync(join(alvo, 'pyproject.toml'), 'utf8')).toContain('uvicorn');
  });
});
