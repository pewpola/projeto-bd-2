import React, { useState } from 'react';
import axios from 'axios';
import ReactFlow, {
  Background,
  Controls,
  Position,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import type { Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';

type PlanNodeData = {
  label: string;
  kind?: 'join' | 'projection' | 'selection' | 'table';
};

type PlanNode = Node<PlanNodeData>;

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

    const size = 1 + (childrenMap.get(nodeId) ?? []).reduce((total, childId) => total + getSubtreeSize(childId), 0);
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

const App: React.FC = () => {
  const [query, setQuery] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<PlanNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [algebra, setAlgebra] = useState('');
  const [error, setError] = useState('');
  const [executionPlan, setExecutionPlan] = useState<string[]>([]);

  const handleProcess = async () => {
    try {
      setError('');
      const response = await axios.post('http://localhost:8081/api/parse', { query });

      if (response.data.nodes) {
        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
          response.data.nodes,
          response.data.edges,
        );
        setNodes(layoutedNodes);
        setEdges(layoutedEdges);
      } else {
        setNodes([]);
        setEdges([]);
      }

      setAlgebra(response.data.algebra ?? '');
      setExecutionPlan(response.data.execution_plan ?? []);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail ?? err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Erro inesperado ao processar a consulta.');
      }

      setAlgebra('');
      setExecutionPlan([]);
      setNodes([]);
      setEdges([]);
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
      <h1 style={{ margin: '0 0 12px', fontSize: '2rem', lineHeight: 1.1 }}>
        Processador de Consultas
      </h1>
      <p style={{ margin: 0, maxWidth: 820, color: '#475569', lineHeight: 1.6 }}>
        O plano de execução agora segue a leitura do nó mais profundo até a raiz, priorizando o
        ramo mais fundo quando a árvore bifurca.
      </p>

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
          placeholder="Digite sua consulta SQL (ex: SELECT c.Nome FROM cliente c JOIN pedido p ON c.idCliente = p.Cliente_idCliente WHERE p.ValorTotalPedido > 100);"
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
          Executar validação e analisar otimização
        </button>

        {algebra && (
          <div
            style={{
              marginTop: '14px',
              padding: '12px 14px',
              borderRadius: '14px',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              color: '#1e3a8a',
              fontSize: 14,
            }}
          >
            <strong>Resumo:</strong> {algebra}
          </div>
        )}
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

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '20px',
          marginTop: '20px',
          flex: 1,
          minHeight: 0,
          alignItems: 'stretch',
        }}
      >
        <div
          style={{
            flex: '1 1 320px',
            minWidth: 280,
            maxWidth: 420,
            overflowY: 'auto',
            backgroundColor: 'rgba(255,255,255,0.94)',
            padding: '18px',
            borderRadius: '20px',
            border: '1px solid rgba(148,163,184,0.18)',
            boxShadow: '0 22px 45px rgba(15, 23, 42, 0.07)',
          }}
        >
          <h3
            style={{
              marginTop: 0,
              marginBottom: '14px',
              color: '#1e293b',
              borderBottom: '1px solid #e2e8f0',
              paddingBottom: '10px',
            }}
          >
            Plano de Execução
          </h3>

          {executionPlan.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {executionPlan.map((step, index) => {
                const isOptimization = step.includes('Otimizacao') || step.includes('Otimização');
                return (
                  <div
                    key={`${step}-${index}`}
                    style={{
                      padding: '12px 14px',
                      backgroundColor: isOptimization ? '#ecfccb' : '#f8fafc',
                      borderLeft: isOptimization ? '4px solid #65a30d' : '4px solid #94a3b8',
                      borderRadius: '12px',
                      fontSize: '0.92rem',
                      lineHeight: 1.5,
                      color: '#0f172a',
                    }}
                  >
                    {step}
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ color: '#64748b', fontSize: '0.95rem', fontStyle: 'italic', lineHeight: 1.6 }}>
              O plano de execução aparecerá aqui após validar uma consulta com sucesso.
            </p>
          )}
        </div>

        <div
          style={{
            flex: '2 1 680px',
            minHeight: 520,
            backgroundColor: 'rgba(255,255,255,0.94)',
            borderRadius: '20px',
            border: '1px solid rgba(148,163,184,0.18)',
            boxShadow: '0 22px 45px rgba(15, 23, 42, 0.07)',
            overflow: 'hidden',
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <Background color="#dbeafe" gap={18} size={1} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
};

export default App;
