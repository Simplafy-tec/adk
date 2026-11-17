import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicySchema, checkAgainstPolicy } from '../src/index.js';

const policy = {
  spec_versions: ['v1'],
  runtimes: { node: '>=20', python: ['3.12'], uv: '>=0.4' },
  limits: {
    script: { default: 1_000_000, max: 5_000_000, timeout: 30 },
    mcp: { default: 1_000_000, max: 5_000_000, timeout: 30 },
    app: { default: 1_000_000, max: 5_000_000, timeout: 30 },
    org: {},
    node: {},
  },
  registries: { allowed_images: [] },
  package: { max_size_bytes: 5_000_000 },
};

describe('PolicySchema', () => {
  it('valida o shape do GET /api/v1/adk/policy', () => {
    expect(PolicySchema.safeParse(policy).success).toBe(true);
  });

  it('rejeita política sem spec_versions', () => {
    const { spec_versions, ...semVersions } = policy;
    expect(PolicySchema.safeParse(semVersions).success).toBe(false);
  });
});

describe('DEFAULT_POLICY', () => {
  // A política embutida (fallback sem Hub) tem de carregar o MESMO
  // teto da classe script que o Hub anuncia em GET /api/v1/adk/policy
  // (`LIMITES_SCRIPT` do hub-v2) — `{}` deixava o build sem teto nenhum.
  it('carrega o teto da classe script igual ao do Hub (cpu 1, memory 512, timeout 60)', () => {
    expect(DEFAULT_POLICY.limits.script).toEqual({ cpu: 1, memory: 512, timeout: 60 });
  });
});

describe('checkAgainstPolicy', () => {
  it('reprova bundle acima do limite de tamanho', () => {
    const issues = checkAgainstPolicy({ kind: 'tool', packageSizeBytes: 10_000_000 }, policy);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('aprova bundle dentro do limite', () => {
    const issues = checkAgainstPolicy({ kind: 'tool', packageSizeBytes: 1000 }, policy);
    expect(issues).toEqual([]);
  });
});

// ui_adherence (N19, ADR-120 §5): a MESMA função pura que o `adk build` chama
// tem de reprovar cor literal, fonte fora do token e logo fora de <Brand/> —
// é o que garante "mesmo resultado no build e no apply" (GATE 3).
describe('checkAgainstPolicy — ui_adherence (kind: app)', () => {
  const appPolicy = policy;

  it('reprova cor literal (#fff) em arquivo de app', () => {
    const issues = checkAgainstPolicy(
      {
        kind: 'app',
        files: [{ path: 'src/App.tsx', text: 'const style = { color: "#ffffff" };' }],
      },
      appPolicy,
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ui_adherence', path: 'src/App.tsx' }),
    );
  });

  it('reprova rgb() literal em arquivo de app', () => {
    const issues = checkAgainstPolicy(
      {
        kind: 'app',
        files: [{ path: 'src/App.css', text: '.card { background: rgb(255, 255, 255); }' }],
      },
      appPolicy,
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
  });

  it('reprova font-family fora do token (--font-*)', () => {
    const issues = checkAgainstPolicy(
      {
        kind: 'app',
        files: [{ path: 'src/App.css', text: '.title { font-family: "Comic Sans MS"; }' }],
      },
      appPolicy,
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
  });

  it('reprova <img> de logo fora de <Brand/>', () => {
    const issues = checkAgainstPolicy(
      {
        kind: 'app',
        files: [{ path: 'src/App.tsx', text: '<img src="logo.svg" alt="Simplafy" />' }],
      },
      appPolicy,
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'ui_adherence' }));
  });

  it('app limpo (tokens e <Brand/>) não gera issue ui_adherence', () => {
    const issues = checkAgainstPolicy(
      {
        kind: 'app',
        files: [
          {
            path: 'src/App.tsx',
            text: 'import { Brand } from "@simpla.fy/app-kit";\nconst style = { color: "var(--color-primary)" };\nexport const App = () => <Brand />;',
          },
        ],
      },
      appPolicy,
    );
    expect(issues.filter((i) => i.code === 'ui_adherence')).toEqual([]);
  });

  it('kind diferente de app não roda o lint de aderência mesmo com cor literal', () => {
    const issues = checkAgainstPolicy(
      { kind: 'tool', files: [{ path: 'src/x.py', text: 'COLOR = "#ffffff"' }] },
      appPolicy,
    );
    expect(issues.filter((i) => i.code === 'ui_adherence')).toEqual([]);
  });
});
