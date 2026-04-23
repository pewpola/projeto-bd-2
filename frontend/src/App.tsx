import { useState } from 'react';
import axios from 'axios';
import ReactFlow, { Background, Controls, Position } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';

type PlanKind = 'join' | 'projection' | 'selection' | 'table';
type PlanNode = Node<{ kind?: PlanKind; label: string }>;
type PlanGraph = { algebra: string; edges: Edge[]; execution_plan: string[]; nodes: PlanNode[] };
type ComparisonStats = {
  original_node_count: number;
  optimized_node_count: number;
  original_step_count: number;
  optimized_step_count: number;
};
type ParseResponse = { comparison?: ComparisonStats; optimized?: PlanGraph; original?: PlanGraph };
type PlanKey = 'original' | 'optimized';

const API_URL = 'http://localhost:8081/api/parse';
const MIN_WIDTH = 220;
const MAX_WIDTH = 360;
const MIN_HEIGHT = 68;
const GAP_X = 56;
const GAP_Y = 84;

const TEXT = {
  title: 'Processador de Consultas SQL',
  intro:
    'Compare lado a lado a Árvore Algébrica Original e a Árvore Algébrica Otimizada para entender a transformação da consulta após as heurísticas de otimização.',
  placeholder:
    'Digite sua consulta SQL. Exemplo: SELECT c.Nome FROM cliente c JOIN pedido p ON c.idCliente = p.Cliente_idCliente WHERE p.ValorTotalPedido > 100;',
  button: 'Comparar árvores',
  buttonBusy: 'Processando...',
  summary: 'Resumo',
  plan: 'Plano de execução',
  empty:
    'Execute uma consulta para visualizar e comparar a Árvore Algébrica Original com a Árvore Algébrica Otimizada.',
  error: 'Erro inesperado ao processar a consulta.',
  comparison: 'Comparativo rápido',
  comparisonNote:
    'A árvore otimizada pode ter mais nós porque explicita seleções e projeções antecipadas. O ganho está em enxergar as operações antes na árvore.',
  original: 'Árvore Algébrica Original',
  optimized: 'Árvore Algébrica Otimizada',
  nodes: 'nós',
  steps: 'etapas',
} as const;

const GRID_COLORS: Record<PlanKey, string> = {
  original: '#cbd5e1',
  optimized: '#bbf7d0',
};

const NODE_COLORS: Record<PlanKind, { background: string; border: string; text: string }> = {
  table: { background: '#eff6ff', border: '#60a5fa', text: '#1e3a8a' },
  selection: { background: '#ecfccb', border: '#84cc16', text: '#365314' },
  projection: { background: '#fef3c7', border: '#f59e0b', text: '#92400e' },
  join: { background: '#fee2e2', border: '#ef4444', text: '#991b1b' },
};

const PLAN_TITLES: Record<PlanKey, string> = {
  original: TEXT.original,
  optimized: TEXT.optimized,
};

const estimateNodeBox = (label: string) => {
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 140 + label.length * 5.1));
  const charsPerLine = Math.max(18, Math.floor((width - 36) / 7));
  return {
    width: Math.round(width),
    height: Math.max(MIN_HEIGHT, 32 + Math.ceil(label.length / charsPerLine) * 20),
  };
};

const layoutPlan = (plan?: PlanGraph | null) => {
  if (!plan) return null;

  const nodes = plan.nodes.map((node) => {
    const { width, height } = estimateNodeBox(node.data.label);
    const colors = NODE_COLORS[node.data.kind ?? 'join'];

    return {
      ...node,
      width,
      height,
      sourcePosition: Position.Top,
      targetPosition: Position.Bottom,
      style: {
        width,
        minHeight: height,
        padding: '14px 16px',
        borderRadius: 18,
        border: `2px solid ${colors.border}`,
        backgroundColor: colors.background,
        color: colors.text,
        fontWeight: 600,
        fontSize: 13,
        lineHeight: 1.35,
        textAlign: 'center' as const,
        whiteSpace: 'normal' as const,
        wordBreak: 'break-word' as const,
        boxShadow: '0 18px 30px rgba(15, 23, 42, 0.08)',
      },
    };
  });

  const edges = plan.edges.map((edge) => ({
    ...edge,
    animated: false,
    type: 'smoothstep' as const,
    style: { stroke: '#94a3b8', strokeWidth: 2 },
  }));

  if (!nodes.length) return { ...plan, nodes, edges };

  const children = new Map<string, string[]>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => children.set(node.id, []));
  edges.forEach(({ source, target }) => children.get(target)?.push(source));

  const sourceIds = new Set(edges.map((edge) => edge.source));
  const rootId = nodes.find((node) => !sourceIds.has(node.id))?.id ?? nodes[0].id;
  const depthCache = new Map<string, number>();
  const sizeCache = new Map<string, number>();
  const widthCache = new Map<string, number>();
  const depthMap = new Map<string, number>();
  const centerMap = new Map<string, number>();

  const subtreeDepth = (nodeId: string): number => {
    const cached = depthCache.get(nodeId);
    if (cached !== undefined) return cached;
    const childIds = children.get(nodeId) ?? [];
    const depth = childIds.length ? 1 + Math.max(...childIds.map(subtreeDepth)) : 0;
    depthCache.set(nodeId, depth);
    return depth;
  };

  const subtreeSize = (nodeId: string): number => {
    const cached = sizeCache.get(nodeId);
    if (cached !== undefined) return cached;
    const size = 1 + (children.get(nodeId) ?? []).reduce((sum, childId) => sum + subtreeSize(childId), 0);
    sizeCache.set(nodeId, size);
    return size;
  };

  const orderedChildren = (nodeId: string) =>
    [...(children.get(nodeId) ?? [])].sort((left, right) => {
      const depthDiff = subtreeDepth(right) - subtreeDepth(left);
      if (depthDiff) return depthDiff;
      const sizeDiff = subtreeSize(right) - subtreeSize(left);
      if (sizeDiff) return sizeDiff;
      return left.localeCompare(right, undefined, { numeric: true });
    });

  const subtreeWidth = (nodeId: string): number => {
    const cached = widthCache.get(nodeId);
    if (cached !== undefined) return cached;

    const nodeWidth = nodeById.get(nodeId)?.width ?? MIN_WIDTH;
    const childIds = orderedChildren(nodeId);
    const width = childIds.length
      ? Math.max(
          nodeWidth,
          childIds.reduce((sum, childId, index) => sum + subtreeWidth(childId) + (index ? GAP_X : 0), 0),
        )
      : nodeWidth;

    widthCache.set(nodeId, width);
    return width;
  };

  const assignDepths = (nodeId: string, depth: number) => {
    depthMap.set(nodeId, depth);
    orderedChildren(nodeId).forEach((childId) => assignDepths(childId, depth + 1));
  };

  const assignCenters = (nodeId: string, left: number) => {
    const node = nodeById.get(nodeId);
    if (!node) return;

    const width = subtreeWidth(nodeId);
    const childIds = orderedChildren(nodeId);
    if (!childIds.length) {
      centerMap.set(nodeId, left + width / 2);
      return;
    }

    const childrenWidth = childIds.reduce(
      (sum, childId, index) => sum + subtreeWidth(childId) + (index ? GAP_X : 0),
      0,
    );

    let currentLeft = left + (width - childrenWidth) / 2;
    childIds.forEach((childId) => {
      assignCenters(childId, currentLeft);
      currentLeft += subtreeWidth(childId) + GAP_X;
    });

    const averageCenter =
      childIds.reduce((sum, childId) => sum + (centerMap.get(childId) ?? 0), 0) / childIds.length;
    const halfWidth = (node.width ?? MIN_WIDTH) / 2;
    centerMap.set(
      nodeId,
      Math.min(left + width - halfWidth, Math.max(left + halfWidth, averageCenter)),
    );
  };

  assignDepths(rootId, 0);
  assignCenters(rootId, 0);

  const heightByDepth = new Map<number, number>();
  nodes.forEach((node) => {
    const depth = depthMap.get(node.id) ?? 0;
    heightByDepth.set(depth, Math.max(heightByDepth.get(depth) ?? 0, node.height ?? MIN_HEIGHT));
  });

  const yByDepth = new Map<number, number>();
  [...heightByDepth.keys()]
    .sort((left, right) => left - right)
    .forEach((depth, index, depths) => {
      if (!index) return yByDepth.set(depth, 0);
      const prevDepth = depths[index - 1];
      const prevY = yByDepth.get(prevDepth) ?? 0;
      yByDepth.set(depth, prevY + (heightByDepth.get(prevDepth) ?? MIN_HEIGHT) + GAP_Y);
    });

  return {
    ...plan,
    edges,
    nodes: nodes.map((node) => {
      const width = node.width ?? MIN_WIDTH;
      return {
        ...node,
        position: {
          x: (centerMap.get(node.id) ?? width / 2) - width / 2,
          y: yByDepth.get(depthMap.get(node.id) ?? 0) ?? 0,
        },
      };
    }),
  };
};

const stepTone = (step: string, plan: PlanKey) => {
  if (step.includes('Produto Cartesiano')) return 'plan-step--alert';
  if (step.includes('Otimiza')) return 'plan-step--success';
  return plan === 'optimized' ? 'plan-step--info' : 'plan-step--default';
};

function MetricPill({ label, plan, value }: { label: string; plan: PlanKey; value: number }) {
  return (
    <div className={`metric-pill metric-pill--${plan}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlanCard({ plan, type }: { plan: PlanGraph; type: PlanKey }) {
  return (
    <section className={`plan-card plan-card--${type}`}>
      <div className="plan-card__header">
        <span className={`plan-card__badge plan-card__badge--${type}`}>{PLAN_TITLES[type]}</span>
        <MetricPill label={TEXT.nodes} plan={type} value={plan.nodes.length} />
        <MetricPill label={TEXT.steps} plan={type} value={plan.execution_plan.length} />
      </div>

      <div className="plan-card__summary">
        <strong>{TEXT.summary}:</strong> {plan.algebra}
      </div>

      <div className="plan-card__graph">
        <ReactFlow
          nodes={plan.nodes}
          edges={plan.edges}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
          minZoom={0.15}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background color={GRID_COLORS[type]} gap={18} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      <div className="plan-card__steps">
        <h3>{TEXT.plan}</h3>
        <div className="plan-card__steps-list">
          {plan.execution_plan.map((step, index) => (
            <div key={`${type}-${index}`} className={`plan-step ${stepTone(step, type)}`}>
              {step}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [comparison, setComparison] = useState<ComparisonStats | null>(null);
  const [plans, setPlans] = useState<Record<PlanKey, PlanGraph | null>>({ original: null, optimized: null });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleProcess = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await axios.post<ParseResponse>(API_URL, { query });

      setComparison(data.comparison ?? null);
      setPlans({
        original: layoutPlan(data.original),
        optimized: layoutPlan(data.optimized),
      });
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.detail ?? err.message
        : err instanceof Error
          ? err.message
          : TEXT.error;

      setError(message);
      setComparison(null);
      setPlans({ original: null, optimized: null });
    } finally {
      setLoading(false);
    }
  };

  const hasComparison = Boolean(comparison && plans.original && plans.optimized);

  return (
    <main className="app-shell">
      <header className="hero">
        <h1>{TEXT.title}</h1>
        <p>{TEXT.intro}</p>
      </header>

      <section className="query-panel">
        <textarea
          rows={4}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={TEXT.placeholder}
        />

        <button type="button" onClick={handleProcess} disabled={loading}>
          {loading ? TEXT.buttonBusy : TEXT.button}
        </button>
      </section>

      {error && (
        <section className="status-panel status-panel--error">
          <strong>Erro:</strong> {error}
        </section>
      )}

      {hasComparison ? (
        <>
          <section className="comparison-panel">
            <h2>{TEXT.comparison}</h2>
            <div className="comparison-panel__metrics">
              <MetricPill label={`${TEXT.original}: ${TEXT.nodes}`} plan="original" value={comparison!.original_node_count} />
              <MetricPill label={`${TEXT.original}: ${TEXT.steps}`} plan="original" value={comparison!.original_step_count} />
              <MetricPill
                label={`${TEXT.optimized}: ${TEXT.nodes}`}
                plan="optimized"
                value={comparison!.optimized_node_count}
              />
              <MetricPill
                label={`${TEXT.optimized}: ${TEXT.steps}`}
                plan="optimized"
                value={comparison!.optimized_step_count}
              />
            </div>
            <p>{TEXT.comparisonNote}</p>
          </section>

          <section className="plans-grid">
            <PlanCard plan={plans.original!} type="original" />
            <PlanCard plan={plans.optimized!} type="optimized" />
          </section>
        </>
      ) : (
        !error && <section className="status-panel">{TEXT.empty}</section>
      )}
    </main>
  );
}

export default App;
