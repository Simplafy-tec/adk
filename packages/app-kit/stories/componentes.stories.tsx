import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  Badge,
  Brand,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  Input,
  Select,
  Switch,
  Toast,
  COLOR_TOKENS,
} from '../src/index.js';

const meta: Meta = {
  title: 'App Kit/Componentes',
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj;

/** Tudo que o pacote exporta, numa página — é o índice do GATE 1. */
export const Todos: Story = {
  render: () => (
    <div className="flex w-[36rem] flex-col gap-6">
      <Brand />
      <div className="flex flex-wrap items-center gap-2">
        <Button>Salvar</Button>
        <Button variant="outline">Cancelar</Button>
        <Button variant="ghost">Editar</Button>
        <Button variant="destructive">Remover</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge>Ativo</Badge>
        <Badge variant="success">Publicado</Badge>
        <Badge variant="warning">Pausado</Badge>
        <Badge variant="destructive">Erro</Badge>
        <Badge variant="muted">Rascunho</Badge>
      </div>
      <Input placeholder="Buscar contato" />
      <Select
        options={[
          { value: 'todos', label: 'Todos' },
          { value: 'ativos', label: 'Ativos' },
        ]}
      />
      <Switch label="Notificar por e-mail" />
      <Card>
        <CardHeader>
          <CardTitle>Card</CardTitle>
          <CardDescription>Superfície padrão de conteúdo.</CardDescription>
        </CardHeader>
      </Card>
      <Toast variant="success" title="Salvo" description="As alterações foram aplicadas." />
    </div>
  ),
};

export const Dialogo: Story = {
  render: () => {
    const [aberto, setAberto] = useState(false);
    return (
      <>
        <Button onClick={() => setAberto(true)}>Abrir diálogo</Button>
        <Dialog
          open={aberto}
          title="Remover integração"
          description="Esta ação não pode ser desfeita."
          confirmLabel="Remover"
          confirmVariant="destructive"
          onConfirm={() => setAberto(false)}
          onCancel={() => setAberto(false)}
        />
      </>
    );
  },
};

/** A paleta pública — o que o lint de aderência aceita como cor. */
export const Tokens: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-2 font-mono text-xs">
      {COLOR_TOKENS.map((t) => (
        <div key={t} className="flex items-center gap-2">
          <span
            className="h-6 w-6 rounded-xs border border-border"
            style={{ background: `var(--color-${t})` }}
          />
          --color-{t}
        </div>
      ))}
    </div>
  ),
};
