import React, { useState, useCallback } from 'react';
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import type { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import axios from 'axios';
import dagre from 'dagre';

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 172;
const nodeHeight = 36;

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'BT') => {
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    node.targetPosition = isHorizontal ? 'left' : 'bottom';
    node.sourcePosition = isHorizontal ? 'right' : 'top';

    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };

    return node;
  });

  return { nodes, edges };
};

const App: React.FC = () => {
    const [query, setQuery] = useState('');
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
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
                response.data.edges
              );
              setNodes([...layoutedNodes]);
              setEdges([...layoutedEdges]);
            }
            if (response.data.algebra) {
                setAlgebra(response.data.algebra);
            }
            if (response.data.execution_plan) {
                setExecutionPlan(response.data.execution_plan);
            } else {
                setExecutionPlan([]);
            }
        } catch (e: any) {
            setError(e.response?.data?.detail || e.message);
            setExecutionPlan([]);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif', padding: '20px', backgroundColor: '#f9fafb' }}>
            <h1 style={{ color: '#111827' }}>Processador de Consultas - Otimizado</h1>
            
            <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <textarea 
                    value={query} 
                    onChange={e => setQuery(e.target.value)} 
                    placeholder="Digite sua consulta SQL (ex: SELECT c.Nome FROM cliente c JOIN pedido p ON c.idCliente = p.Cliente_idCliente WHERE p.ValorTotalPedido > 100);"
                    rows={4}
                    style={{ width: '100%', marginBottom: '10px', padding: '10px', border: '1px solid #d1d5db', borderRadius: '4px', boxSizing: 'border-box' }}
                />
                
                <button onClick={handleProcess} style={{ padding: '10px 20px', cursor: 'pointer', background: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>
                   Executar Validação e Analisar Otimização
                </button>
            </div>
            
            {error && <div style={{ color: '#b91c1c', marginTop: '10px', padding: '10px', backgroundColor: '#fef2f2', borderRadius: '4px', borderLeft: '4px solid #ef4444' }}><strong>Erro:</strong> {error}</div>}
            
            <div style={{ display: 'flex', gap: '20px', marginTop: '20px', flex: 1, minHeight: 0 }}>
                {/* Lateral Esquerda - Plano de Execução */}
                <div style={{ width: '35%', overflowY: 'auto', backgroundColor: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                    <h3 style={{ marginTop: 0, color: '#374151', borderBottom: '1px solid #e5e7eb', paddingBottom: '10px' }}>📜 Plano de Execução</h3>
                    {executionPlan.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
                            {executionPlan.map((step, idx) => {
                                const isOpt = step.includes('Otimização');
                                return (
                                    <div key={idx} style={{ 
                                        padding: '10px', 
                                        backgroundColor: isOpt ? '#dcfce7' : '#f3f4f6', 
                                        borderLeft: isOpt ? '4px solid #22c55e' : '4px solid #9ca3af',
                                        borderRadius: '4px',
                                        fontSize: '0.9em',
                                        color: '#1f2937'
                                    }}>
                                        {step}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <p style={{ color: '#6b7280', fontSize: '0.9em', fontStyle: 'italic' }}>O plano de execução aparecerá aqui após validar uma consulta com sucesso.</p>
                    )}
                </div>

                {/* Lateral Direita - Grafo */}
                <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                     <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        fitView
                     >
                        <Background />
                        <Controls />
                     </ReactFlow>
                </div>
            </div>
            
        </div>
    );
};

export default App;
