import { describe, expect, it } from 'vitest';
import { isPending, resolveReference, toSlug } from '../src/index.js';

describe('toSlug', () => {
  it('remove acento, baixa caixa e separa por hífen', () => {
    expect(toSlug('Funil de Produtores')).toBe('funil-de-produtores');
  });

  it('já é idempotente para um slug', () => {
    expect(toSlug('ana')).toBe('ana');
  });
});

describe('resolveReference', () => {
  const resources = [
    { id: 'id-1', name: 'Funil de Produtores' },
    { id: 'id-2', name: 'Funil Ambíguo' },
    { id: 'id-3', name: 'Funil Ambíguo' },
  ];

  it('resolve quando há exatamente um casamento', () => {
    const r = resolveReference('funil-de-produtores', resources);
    expect(r).toEqual({ status: 'resolved', id: 'id-1' });
  });

  it('fica pending not_found quando nada casa', () => {
    const r = resolveReference('nao-existe', resources);
    expect(r).toEqual({ status: 'pending', reason: 'not_found', slug: 'nao-existe', candidates: 0 });
    expect(isPending(r)).toBe(true);
  });

  it('fica pending ambiguous quando mais de um casa', () => {
    const r = resolveReference('funil-ambiguo', resources);
    expect(r).toEqual({
      status: 'pending',
      reason: 'ambiguous',
      slug: 'funil-ambiguo',
      candidates: 2,
    });
  });
});
