import React, { useState } from 'react';
import axios from 'axios';
import ReactFlow, { Background, Controls, Position } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';

type PlanNodeData = {
  label: string;
  kind?: 'join' | 'projection' | 'selection' | 'table';
};

type PlanNode = Node<PlanNodeData>;

type PlanGraph = {
  algebra: string;
  edges: Edge[];
  execution_plan: string[];
  nodes: PlanNode[];
};

type ComparisonStats = {
  original_node_count: number;
  optimized_node_count: number;
  original_step_count: number;
  optimized_step_count: number;
};

type ParseResponse = {
  comparison?: ComparisonStats;
  optimized?: PlanGraph;
  original?: PlanGraph;
};

type PlanVariant = 'original' | 'optimized';

const COPY = {
  title: 'Processador de Consultas SQL',
  intro:
    'Compare lado a lado a \u00c1rvore Alg\u00e9brica Original e a \u00c1rvore Alg\u00e9brica Otimizada para entender como a consulta evolui ap\u00f3s as heur\u00edsticas de otimiza\u00e7\u00e3o.',
  placeholder:
    'Digite sua consulta SQL. Exemplo: SELECT c.Nome FROM cliente c JOIN pedido p ON c.idCliente = p.Cliente_idCliente WHERE p.ValorTotalPedido > 100;',
  runButton: 'Comparar \u00e1rvores',
  summaryLabel: 'Resumo',
  executionPlanTitle: 'Plano de execu\u00e7\u00e3o',
  emptyPlan:
    'Execute uma consulta para visualizar e comparar a \u00c1rvore Alg\u00e9brica Original com a \u00c1rvore Alg\u00e9brica Otimizada.',
  unexpectedError: 'Erro inesperado ao processar a consulta.',
  comparisonTitle: 'Comparativo r\u00e1pido',
  comparisonNote:
    'A vers\u00e3o otimizada pode ter mais n\u00f3s porque explicita sele\u00e7\u00f5es e proje\u00e7\u00f5es antecipadas. O ganho educacional est\u00e1 em enxergar as opera\u00e7\u00f5es mais cedo na \u00e1rvore.',
  originalTitle: '\u00c1rvore Alg\u00e9brica Original',
  optimizedTitle: '\u00c1rvore Alg\u00e9brica Otimizada',
  nodeCount: 'n\u00f3s',
  stepCount: 'etapas',
} as const;

const PLAN_THEME: Record<
  PlanVariant,
  {
    badgeBackground: string;
    badgeBorder: string;
    badgeColor: string;
    cardBackground: string;
    cardBorder: string;
    graphBackground: string;
    graphGrid: string;
    headerColor: string;
  }
> = {
  original: {
    badgeBackground: '#e2e8f0',
    badgeBorder: '#94a3b8',
    badgeColor: '#0f172a',
    cardBackground: 'rgba(255,255,255,0.96)',
    cardBorder: 'rgba(148,163,184,0.28)',
    graphBackground: '#f8fafc',
    graphGrid: '#cbd5e1',
    headerColor: '#0f172a',
  },
  optimized: {
    badgeBackground: '#dcfce7',
    badgeBorder: '#4ade80',
    badgeColor: '#166534',
    cardBackground: 'rgba(240,253,244,0.92)',
    cardBorder: 'rgba(74,222,128,0.35)',
    graphBackground: '#f7fee7',
    graphGrid: '#bbf7d0',
    headerColor: '#166534',
  },
};

const MIN_NODE_WIDTH = 220;
const MAX_NODE_WIDTH = 360;
const MIN_NODE_HEIGHT = 68;
const HORIZONTAL_GAP = 56;
const VERTICAL_GAP = 84;

const estimateNodeDimensions = (label: string) => {
  const width = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, 140 + label.length * 5.1));
  const charsPerLine = Math.max(18, Math.floor((width - 36) / 7));
  const lineCount = Math.max(1, Math.ceil(label.length / charsPerLine));
  const height = Math.max(MIN_NODE_HEIGHT, 32 + lineCount * 20);

  return {
    width: Math.round(width),
    height: Math.round(height),
  };
};

const getNodePalette = (kind?: PlanNodeData['kind']) => {
  if (kind === 'table') {
    return {
      backgroundColor: '#eff6ff',
      borderColor: '#60a5fa',
      color: '#1e3a8a',
    };
  }

  if (kind === 'selection') {
    return {
      backgroundColor: '#ecfccb',
      borderColor: '#84cc16',
      color: '#365314',
    };
  }

  if (kind === 'projection') {
    return {
      backgroundColor: '#fef3c7',
      borderColor: '#f59e0b',
      color: '#92400e',
    };
  }

  return {
    backgroundColor: '#fee2e2',
    borderColor: '#ef4444',
    color: '#991b1b',
  };
};

const getOrderedChildren = (
  nodeId: string,
  childrenMap: Map<string, string[]>,
  getSubtreeHeight: (id: string) => number,
  getSubtreeSize: (id: string) => number,
) =>
  [...(childrenMap.get(nodeId) ?? [])].sort((left, right) => {
    const heightDiff = getSubtreeHeight(right) - getSubtreeHeight(left);
    if (heightDiff !== 0) {
      return heightDiff;
    }

    const sizeDiff = getSubtreeSize(right) - getSubtreeSize(left);
    if (sizeDiff !== 0) {
      return sizeDiff;
    }

    return left.localeCompare(right, undefined, { numeric: true });
  });

const getLayoutedElements = (inputNodes: PlanNode[], inputEdges: Edge[]) => {
  if (!inputNodes.length) {
    return { nodes: [], edges: [] };
  }

  const sizedNodes = inputNodes.map((node) => {
    const { width, height } = estimateNodeDimensions(node.data.label);
    const palette = getNodePalette(node.data.kind);

    return {
      ...node,
      width,
      height,
      style: {
        width,
        minHeight: height,
        padding: '14px 16px',
        borderRadius: 18,
        border: `2px solid ${palette.borderColor}`,
        backgroundColor: palette.backgroundColor,
        color: palette.color,
        fontWeight: 600,
        fontSize: 13,
        lineHeight: 1.35,
        textAlign: 'center' as const,
        whiteSpace: 'normal' as const,
        wordBreak: 'break-word' as const,
        boxShadow: '0 18px 30px rgba(15, 23, 42, 0.08)',
      },
      sourcePosition: Position.Top,
      targetPosition: Position.Bottom,
    };
  });

  const nodeMap = new Map(sizedNodes.map((node) => [node.id, node]));
  const childrenMap = new Map<string, string[]>();

  sizedNodes.forEach((node) => {
    childrenMap.set(node.id, []);
  });

  inputEdges.forEach((edge) => {
    const children = childrenMap.get(edge.target) ?? [];
    children.push(edge.source);
    childrenMap.set(edge.target, children);
  });

  const sourceIds = new Set(inputEdges.map((edge) => edge.source));
  const rootNode = sizedNodes.find((node) => !sourceIds.has(node.id)) ?? sizedNodes[0];

  const subtreeHeightCache = new Map<string, number>();
  const subtreeSizeCache = new Map<string, number>();
  const subtreeWidthCache = new Map<string, number>();
  const depthMap = new Map<string, number>();
  const centerMap = new Map<string, number>();

  const getSubtreeHeight = (nodeId: string): number => {
    const cached = subtreeHeightCache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    const children = childrenMap.get(nodeId) ?? [];
    const height =
      children.length === 0
        ? 0
        : 1 + Math.max(...children.map((childId) => getSubtreeHeight(childId)));

    subtreeHeightCache.set(nodeId, height);
    return height;
  };

  const getSubtreeSize = (nodeId: string): number => {
    const cached = subtreeSizeCache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    const size =
      1 + (childrenMap.get(nodeId) ?? []).reduce((total, childId) => total + getSubtreeSize(childId), 0);
    subtreeSizeCache.set(nodeId, size);
    return size;
  };

  const getSubtreeWidth = (nodeId: string): number => {
    const cached = subtreeWidthCache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    const node = nodeMap.get(nodeId);
    if (!node) {
      return MIN_NODE_WIDTH;
    }

    const children = getOrderedChildren(nodeId, childrenMap, getSubtreeHeight, getSubtreeSize);
    if (!children.length) {
      subtreeWidthCache.set(nodeId, node.width ?? MIN_NODE_WIDTH);
      return node.width ?? MIN_NODE_WIDTH;
    }

    const childrenWidth = children.reduce((total, childId, index) => {
      return total + getSubtreeWidth(childId) + (index > 0 ? HORIZONTAL_GAP : 0);
    }, 0);

    const width = Math.max(node.width ?? MIN_NODE_WIDTH, childrenWidth);
    subtreeWidthCache.set(nodeId, width);
    return width;
  };

  const assignDepths = (nodeId: string, depth: number) => {
    depthMap.set(nodeId, depth);
    const children = getOrderedChildren(nodeId, childrenMap, getSubtreeHeight, getSubtreeSize);
    children.forEach((childId) => assignDepths(childId, depth + 1));
  };

  const assignCenters = (nodeId: string, leftBoundary: number) => {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    const subtreeWidth = getSubtreeWidth(nodeId);
    const children = getOrderedChildren(nodeId, childrenMap, getSubtreeHeight, getSubtreeSize);

    if (!children.length) {
      centerMap.set(nodeId, leftBoundary + subtreeWidth / 2);
      return;
    }

    const childrenTotalWidth = children.reduce((total, childId, index) => {
      return total + getSubtreeWidth(childId) + (index > 0 ? HORIZONTAL_GAP : 0);
    }, 0);

    let childLeft = leftBoundary + (subtreeWidth - childrenTotalWidth) / 2;
    children.forEach((childId) => {
      assignCenters(childId, childLeft);
      childLeft += getSubtreeWidth(childId) + HORIZONTAL_GAP;
    });

    const averageChildCenter =
      children.reduce((total, childId) => total + (centerMap.get(childId) ?? 0), 0) / children.length;
    const halfNodeWidth = (node.width ?? MIN_NODE_WIDTH) / 2;
    const boundedCenter = Math.min(
      leftBoundary + subtreeWidth - halfNodeWidth,
      Math.max(leftBoundary + halfNodeWidth, averageChildCenter),
    );

    centerMap.set(nodeId, boundedCenter);
  };

  assignDepths(rootNode.id, 0);
  assignCenters(rootNode.id, 0);

  const maxHeightPerDepth = new Map<number, number>();
  sizedNodes.forEach((node) => {
    const depth = depthMap.get(node.id) ?? 0;
    const currentMax = maxHeightPerDepth.get(depth) ?? 0;
    maxHeightPerDepth.set(depth, Math.max(currentMax, node.height ?? MIN_NODE_HEIGHT));
  });

  const sortedDepths = [...maxHeightPerDepth.keys()].sort((left, right) => left - right);
  const yByDepth = new Map<number, number>();
  let currentY = 0;

  sortedDepths.forEach((depth, index) => {
    if (index === 0) {
      yByDepth.set(depth, currentY);
      return;
    }

    const previousDepth = sortedDepths[index - 1];
    currentY += (maxHeightPerDepth.get(previousDepth) ?? MIN_NODE_HEIGHT) + VERTICAL_GAP;
    yByDepth.set(depth, currentY);
  });

  const nodes = sizedNodes.map((node) => {
    const width = node.width ?? MIN_NODE_WIDTH;
    const depth = depthMap.get(node.id) ?? 0;
    const centerX = centerMap.get(node.id) ?? width / 2;
    const y = yByDepth.get(depth) ?? 0;

    return {
      ...node,
      position: {
        x: centerX - width / 2,
        y,
      },
    };
  });

  const edges = inputEdges.map((edge) => ({
    ...edge,
    animated: false,
    type: 'smoothstep' as const,
    style: {
      stroke: '#94a3b8',
      strokeWidth: 2,
    },
  }));

  return { nodes, edges };
};

const preparePlan = (plan?: PlanGraph | null): PlanGraph | null => {
  if (!plan) {
    return null;
  }

  const { nodes, edges } = getLayoutedElements(plan.nodes ?? [], plan.edges ?? []);
  return {
    ...plan,
    nodes,
    edges,
  };
};

const getStepColors = (step: string, variant: PlanVariant) => {
  if (step.includes('Produto Cartesiano')) {
    return {
      backgroundColor: '#fef2f2',
      borderColor: '#ef4444',
      color: '#991b1b',
    };
  }

  if (step.includes('Otimiza')) {
    return {
      backgroundColor: '#ecfccb',
      borderColor: '#65a30d',
      color: '#365314',
    };
  }

  if (variant === 'optimized') {
    return {
      backgroundColor: '#eff6ff',
      borderColor: '#60a5fa',
      color: '#1d4ed8',
    };
  }

  return {
    backgroundColor: '#f8fafc',
    borderColor: '#94a3b8',
    color: '#0f172a',
  };
};

const MetricPill: React.FC<{
  color: string;
  label: string;
  value: number;
}> = ({ color, label, value }) => (
  <div
    style={{
      padding: '10px 14px',
      borderRadius: 999,
      border: `1px solid ${color}`,
      backgroundColor: 'rgba(255,255,255,0.7)',
      color: '#0f172a',
      fontSize: 13,
      fontWeight: 700,
    }}
  >
    <span style={{ color: '#475569', fontSize: 12, fontWeight: 600 }}>{label}</span>{' '}
    <span style={{ color: '#0f172a', fontSize: 14, fontWeight: 800 }}>{value}</span>
  </div>
);

const PlanCard: React.FC<{
  plan: PlanGraph;
  title: string;
  variant: PlanVariant;
}> = ({ plan, title, variant }) => {
  const theme = PLAN_THEME[variant];

  return (
    <section
      style={{
        flex: '1 1 560px',
        minWidth: 320,
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '18px',
        borderRadius: '22px',
        border: `1px solid ${theme.cardBorder}`,
        backgroundColor: theme.cardBackground,
        boxShadow: '0 22px 45px rgba(15, 23, 42, 0.07)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '8px 12px',
            borderRadius: 999,
            border: `1px solid ${theme.badgeBorder}`,
            backgroundColor: theme.badgeBackground,
            color: theme.badgeColor,
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </span>
        <MetricPill color={theme.badgeBorder} label={COPY.nodeCount} value={plan.nodes.length} />
        <MetricPill color={theme.badgeBorder} label={COPY.stepCount} value={plan.execution_plan.length} />
      </div>

      <div
        style={{
          padding: '14px 16px',
          borderRadius: '16px',
          backgroundColor: 'rgba(255,255,255,0.82)',
          border: `1px solid ${theme.cardBorder}`,
          color: '#334155',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: theme.headerColor }}>{COPY.summaryLabel}:</strong> {plan.algebra}
      </div>

      <div
        style={{
          minHeight: 420,
          borderRadius: '18px',
          overflow: 'hidden',
          border: `1px solid ${theme.cardBorder}`,
          backgroundColor: theme.graphBackground,
        }}
      >
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
          <Background color={theme.graphGrid} gap={18} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      <div>
        <h3
          style={{
            margin: '0 0 12px',
            color: '#1e293b',
            fontSize: '1rem',
          }}
        >
          {COPY.executionPlanTitle}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {plan.execution_plan.map((step, index) => {
            const colors = getStepColors(step, variant);

            return (
              <div
                key={`${title}-${index}`}
                style={{
                  padding: '12px 14px',
                  borderRadius: '14px',
                  borderLeft: `4px solid ${colors.borderColor}`,
                  backgroundColor: colors.backgroundColor,
                  color: colors.color,
                  lineHeight: 1.5,
                  fontSize: 14,
                }}
              >
                {step}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

const App: React.FC = () => {
  const [query, setQuery] = useState('');
  const [comparison, setComparison] = useState<ComparisonStats | null>(null);
  const [originalPlan, setOriginalPlan] = useState<PlanGraph | null>(null);
  const [optimizedPlan, setOptimizedPlan] = useState<PlanGraph | null>(null);
  const [error, setError] = useState('');

  const handleProcess = async () => {
    try {
      setError('');
      const response = await axios.post<ParseResponse>('http://localhost:8081/api/parse', { query });

      setOriginalPlan(preparePlan(response.data.original));
      setOptimizedPlan(preparePlan(response.data.optimized));
      setComparison(response.data.comparison ?? null);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail ?? err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(COPY.unexpectedError);
      }

      setComparison(null);
      setOriginalPlan(null);
      setOptimizedPlan(null);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        padding: '24px',
        boxSizing: 'border-box',
        background:
          'radial-gradient(circle at top left, rgba(59,130,246,0.12), transparent 28%), #f8fafc',
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        color: '#0f172a',
      }}
    >
      <h1 style={{ margin: '0 0 12px', fontSize: '2rem', lineHeight: 1.1 }}>{COPY.title}</h1>
      <p style={{ margin: 0, maxWidth: 940, color: '#475569', lineHeight: 1.6 }}>{COPY.intro}</p>

      <div
        style={{
          marginTop: '20px',
          backgroundColor: 'rgba(255,255,255,0.92)',
          padding: '20px',
          borderRadius: '20px',
          border: '1px solid rgba(148,163,184,0.2)',
          boxShadow: '0 22px 45px rgba(15, 23, 42, 0.08)',
        }}
      >
        <textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={COPY.placeholder}
          rows={4}
          style={{
            width: '100%',
            marginBottom: '12px',
            padding: '14px 16px',
            border: '1px solid #cbd5e1',
            borderRadius: '14px',
            boxSizing: 'border-box',
            resize: 'vertical',
            fontSize: 14,
            lineHeight: 1.5,
            color: '#0f172a',
            backgroundColor: '#fff',
          }}
        />

        <button
          onClick={handleProcess}
          style={{
            padding: '12px 22px',
            cursor: 'pointer',
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
            color: 'white',
            border: 'none',
            borderRadius: '999px',
            fontWeight: 700,
            boxShadow: '0 12px 24px rgba(37, 99, 235, 0.25)',
          }}
        >
          {COPY.runButton}
        </button>
      </div>

      {error && (
        <div
          style={{
            color: '#991b1b',
            marginTop: '14px',
            padding: '14px 16px',
            backgroundColor: '#fef2f2',
            borderRadius: '14px',
            borderLeft: '5px solid #ef4444',
          }}
        >
          <strong>Erro:</strong> {error}
        </div>
      )}

      {comparison && originalPlan && optimizedPlan ? (
        <>
          <div
            style={{
              marginTop: '20px',
              padding: '18px',
              borderRadius: '20px',
              backgroundColor: 'rgba(255,255,255,0.94)',
              border: '1px solid rgba(148,163,184,0.22)',
              boxShadow: '0 22px 45px rgba(15, 23, 42, 0.06)',
            }}
          >
            <h2 style={{ margin: '0 0 10px', fontSize: '1.1rem', color: '#0f172a' }}>{COPY.comparisonTitle}</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <MetricPill
                color="#94a3b8"
                label={`${COPY.originalTitle}: ${COPY.nodeCount}`}
                value={comparison.original_node_count}
              />
              <MetricPill
                color="#94a3b8"
                label={`${COPY.originalTitle}: ${COPY.stepCount}`}
                value={comparison.original_step_count}
              />
              <MetricPill
                color="#4ade80"
                label={`${COPY.optimizedTitle}: ${COPY.nodeCount}`}
                value={comparison.optimized_node_count}
              />
              <MetricPill
                color="#4ade80"
                label={`${COPY.optimizedTitle}: ${COPY.stepCount}`}
                value={comparison.optimized_step_count}
              />
            </div>
            <p style={{ margin: '12px 0 0', color: '#475569', lineHeight: 1.6 }}>{COPY.comparisonNote}</p>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '20px',
              marginTop: '20px',
              alignItems: 'stretch',
            }}
          >
            <PlanCard plan={originalPlan} title={COPY.originalTitle} variant="original" />
            <PlanCard plan={optimizedPlan} title={COPY.optimizedTitle} variant="optimized" />
          </div>
        </>
      ) : (
        !error && (
          <div
            style={{
              marginTop: '20px',
              padding: '18px',
              borderRadius: '20px',
              backgroundColor: 'rgba(255,255,255,0.9)',
              border: '1px solid rgba(148,163,184,0.2)',
              color: '#64748b',
              lineHeight: 1.6,
            }}
          >
            {COPY.emptyPlan}
          </div>
        )
      )}
    </div>
  );
};

export default App;
