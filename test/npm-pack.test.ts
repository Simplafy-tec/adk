import { describe, expect, it } from 'vitest';
import { arquivosDoPack, relatorioDoPack } from './npm-pack.js';

describe('relatorioDoPack — tolera o formato do npm, não o conteúdo', () => {
  it('npm 11: array de relatórios', () => {
    const saida = JSON.stringify([{ name: 'p', files: [{ path: 'dist/i.js' }] }]);
    expect(arquivosDoPack(saida)).toEqual(['dist/i.js']);
  });

  it('npm 12: objeto único', () => {
    const saida = JSON.stringify({ name: 'p', files: [{ path: 'dist/i.js' }] });
    expect(arquivosDoPack(saida)).toEqual(['dist/i.js']);
  });

  it('objeto que embrulha o relatório numa chave', () => {
    const saida = JSON.stringify({ resultado: { files: [{ path: 'a.js' }] } });
    expect(arquivosDoPack(saida)).toEqual(['a.js']);
  });

  it('LANÇA quando não há relatório — degradar para lista vazia aprovaria qualquer tarball', () => {
    // Este é o caso que importa: os testes que usam isto procuram `.env` e
    // `credentials.json` no pacote. Se um formato novo virasse `[]`, todos
    // ficariam verdes justamente quando pararam de olhar.
    expect(() => relatorioDoPack(JSON.stringify({ erro: 'formato novo' }))).toThrow(/files/);
    expect(() => relatorioDoPack(JSON.stringify([]))).toThrow(/files/);
  });
});
