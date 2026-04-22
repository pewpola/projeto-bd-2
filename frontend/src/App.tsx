import React, { useState, useCallback } from "react";
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
} from "reactflow";
import type { Node, Edge } from "reactflow";
import "reactflow/dist/style.css";
import axios from "axios";
import dagre from "dagre";

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 172;
const nodeHeight = 36;

const getLayoutedElements = (
  nodes: Node[],
  edges: Edge[],
  direction = "TB",
) => {
  const isHorizontal = direction === "LR";
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
    node.targetPosition = isHorizontal ? "left" : "top";
    node.sourcePosition = isHorizontal ? "right" : "bottom";

    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };

    return node;
  });

  return { nodes, edges };
};

const App: React.FC = () => {
  const [query, setQuery] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [algebra, setAlgebra] = useState("");
  const [error, setError] = useState("");

  const handleProcess = async () => {
    try {
      setError("");
      const response = await axios.post("http://localhost:8081/api/parse", {
        query,
      });

      if (response.data.nodes) {
        const { nodes: layoutedNodes, edges: layoutedEdges } =
          getLayoutedElements(response.data.nodes, response.data.edges);
        setNodes([...layoutedNodes]);
        setEdges([...layoutedEdges]);
      }
      if (response.data.algebra) {
        setAlgebra(response.data.algebra);
      }
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "sans-serif",
        padding: "20px",
      }}
    >
      <h1>Processador de Consultas - Banco de Dados</h1>
      <div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Digite sua consulta SQL (ex: SELECT * FROM cliente);"
          rows={4}
          style={{ width: "100%", marginBottom: "10px", padding: "10px" }}
        />
      </div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <button
          onClick={handleProcess}
          style={{
            padding: "10px 20px",
            cursor: "pointer",
            background: "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
          }}
        >
          Analisar Consulta
        </button>
      </div>
      {error && (
        <div style={{ color: "red", marginBottom: "10px" }}>{error}</div>
      )}

      {algebra && (
        <div
          style={{
            marginBottom: "20px",
            padding: "10px",
            backgroundColor: "#f0f0f0",
            borderRadius: "4px",
          }}
        >
          <strong>Álgebra Relacional:</strong>
          <div style={{ fontSize: "1.2em", marginTop: "5px" }}>{algebra}</div>
        </div>
      )}

      <div
        style={{
          flex: 1,
          border: "1px solid #ccc",
          borderRadius: "4px",
          minHeight: "400px",
        }}
      >
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
  );
};

export default App;
