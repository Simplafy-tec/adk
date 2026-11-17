import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// Rodada de correção N19, item 1 (média·security): `IGNORADAS` do pacote.ts
// (usada por `listarArquivos`, a ÚNICA entrada do `ui_adherence` e do
// `scanLeaks`) inclui `build/` e `storybook-static/` — pastas que o `.gitignore`
// do template `init app` NÃO versiona. Resultado hoje: um arquivo colocado em
// `build/` passa direto pelo portão, cor literal ou segredo incluídos, com
// exit 0. A regra do brief é que "a lista do que o portão NÃO varre tem de
// ser igual à lista do que o template NÃO versiona".

describe('adk build — portão cobre build/ (item 1, N19 rodada de correção)', () => {
  let dir: string;
  let appDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-portao-'));
    appDir = join(dir, 'demo-app');
    await runCli(['init', 'app', 'demo-app', '--dir', appDir], { cwd: dir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('arquivo em build/ com cor literal reprova com ui_adherence (hoje passa direto, exit 0)', async () => {
    mkdirSync(join(appDir, 'build'), { recursive: true });
    writeFileSync(
      join(appDir, 'build', 'Sneaky.tsx'),
      'export const Sneaky = () => <div style={{ color: "#ff0000" }}>oi</div>;\n',
    );
    const result = await runCli(['build', '--dir', appDir], { cwd: dir });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
    expect(result.exitCode).toBe(1);
  });

  it('arquivo em build/ com segredo literal reprova com secret_literal (hoje passa direto, exit 0)', async () => {
    mkdirSync(join(appDir, 'build'), { recursive: true });
    writeFileSync(
      join(appDir, 'build', 'Sneaky.tsx'),
      'export const token = "sk-ant-abcdefgh12345678";\n',
    );
    const result = await runCli(['build', '--dir', appDir], { cwd: dir });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
    expect(result.exitCode).toBe(1);
  });

  it('.gitignore do template init app NÃO versiona build/ (confirma o mismatch com o portão)', () => {
    expect(existsSync(join(appDir, '.gitignore'))).toBe(true);
    const gitignore = readFileSync(join(appDir, '.gitignore'), 'utf8');
    // Hoje o .gitignore não cobre `build/` — o app gerado versionaria (ou não,
    // dependendo do git) o mesmo diretório que o portão pula. As duas listas
    // (o que o portão NÃO varre e o que o git NÃO versiona) têm de bater.
    expect(gitignore).toContain('build/');
  });
});
