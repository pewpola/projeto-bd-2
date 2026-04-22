import sqlglot
from sqlglot import exp
from schema import SCHEMA
from typing import List, Dict, Any, Tuple
import re
import uuid

class SQLProcessor:
    def __init__(self, schema: Dict[str, Dict[str, str]]):
        self.schema = {k.lower(): {c.lower(): t for c, t in v.items()} for k, v in schema.items()}
        self.nodes = []
        self.edges = []
        self.node_counter = 0
        
    def _validate_table_exists(self, table_name: str):
        if table_name.lower() not in self.schema:
            raise ValueError(f"Tabela '{table_name}' não encontrada no esquema.")

    def _add_node(self, label: str) -> str:
        self.node_counter += 1
        node_id = str(self.node_counter)
        self.nodes.append({
            "id": node_id,
            "data": { "label": label },
            "position": { "x": 0, "y": 0 }
        })
        return node_id

    def _add_edge(self, source: str, target: str):
        self.edges.append({
            "id": f"e{source}-{target}",
            "source": source,
            "target": target,
            "animated": True
        })

    def process(self, query: str) -> Dict[str, Any]:
        self.nodes = []
        self.edges = []
        self.node_counter = 0

        try:
            ast = sqlglot.parse_one(query)
            if not isinstance(ast, exp.Select):
                 raise ValueError("Suporte provido somente para consultas SELECT.")
        except Exception as e:
            raise ValueError(f"Erro de sintaxe SQL ou não suportada: {str(e)}")
            
        tables_in_query = {} # alias -> real name
        for table in ast.find_all(exp.Table):
            real_name = table.name.lower()
            alias = table.alias.lower() if table.alias else real_name
            self._validate_table_exists(real_name)
            tables_in_query[alias] = real_name
            
        table_nodes = {}
        for alias, table_real in tables_in_query.items():
            node_id = self._add_node(table_real)
            table_nodes[alias] = node_id

        current_node_id = None
        if len(table_nodes) == 1:
            current_node_id = list(table_nodes.values())[0]
        elif len(table_nodes) > 1:
             aliases = list(table_nodes.keys())
             current_node_id = table_nodes[aliases[0]]
             for i in range(1, len(aliases)):
                 join_node = self._add_node("⨝ (Join/Cartesiano)")
                 self._add_edge(current_node_id, join_node)
                 self._add_edge(table_nodes[aliases[i]], join_node)
                 current_node_id = join_node

        if ast.args.get('where'):
            where_cond = ast.args['where'].this.sql()
            where_node = self._add_node(f"σ ({where_cond})")
            if current_node_id:
                self._add_edge(current_node_id, where_node)
            current_node_id = where_node

        projections = []
        for e in ast.expressions:
            projections.append(e.sql())
        
        proj_str = ", ".join(projections)
        proj_node = self._add_node(f"π ({proj_str})")
        if current_node_id:
            self._add_edge(current_node_id, proj_node)
        
        algebra_expr = f"π_{{{proj_str}}}"
        
        tables_str = " ⨝ ".join(tables_in_query.values())
        
        if ast.args.get('where'):
             where_cond = ast.args['where'].this.sql()
             algebra_expr += f"(σ_{{{where_cond}}}({tables_str}))"
        else:
             algebra_expr += f"({tables_str})"

        return {
            "nodes": self.nodes,
            "edges": self.edges,
            "algebra": algebra_expr
        }
