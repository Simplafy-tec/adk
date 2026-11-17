import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgIdDaPasta } from '../src/org-config.js';

// org.yaml parseado com `yaml` (não regex) — comentário e indentação variada.

describe('orgIdDaPasta', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-orgyaml-'));
    mkdirSync(join(dir, 'orgs', 'acme'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lê o ambiente com comentário e indentação de 4 espaços', () => {
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      [
        '# comentário solto antes do bloco',
        'environments:',
        '    staging: org-staging-1  # outro comentário na mesma linha',
        '    prod: org-prod-1',
      ].join('\n'),
    );
    expect(orgIdDaPasta(dir, 'acme', 'staging')).toBe('org-staging-1');
    expect(orgIdDaPasta(dir, 'acme', 'prod')).toBe('org-prod-1');
  });

  it('devolve null quando a pasta não declara org.yaml', () => {
    expect(orgIdDaPasta(dir, 'inexistente', 'staging')).toBeNull();
  });

  it('devolve null quando o ambiente pedido não está declarado', () => {
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', '  staging: org-staging-1'].join('\n'),
    );
    expect(orgIdDaPasta(dir, 'acme', 'prod')).toBeNull();
  });
});
