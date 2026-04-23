from typing import Any, Dict, List

import sqlglot
from sqlglot import exp

SIGMA = "\u03c3"
PI = "\u03c0"
JOIN = "\u2a1d"


class SQLProcessor:
    def __init__(self, schema: Dict[str, Dict[str, str]]):
        self.schema = {k.lower(): {c.lower(): t for c, t in v.items()} for k, v in schema.items()}
        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self.node_counter = 0

    def _validate_table_exists(self, table_name: str):
        if table_name.lower() not in self.schema:
            raise ValueError(f"Tabela '{table_name}' nao encontrada no esquema.")

    def _add_node(self, label: str, kind: str = "operation") -> str:
        self.node_counter += 1
        node_id = str(self.node_counter)
        self.nodes.append({
            "id": node_id,
            "data": {"label": label, "kind": kind},
            "position": {"x": 0, "y": 0},
        })
        return node_id

    def _add_edge(self, source: str, target: str):
        self.edges.append({
            "id": f"e{source}-{target}",
            "source": source,
            "target": target,
            "animated": True,
        })

    def _get_tables_for_cond(self, cond: exp.Expression, tables: Dict[str, str]) -> List[str]:
        columns = list(cond.find_all(exp.Column))
        cond_tables = set()

        for column in columns:
            if column.table:
                cond_tables.add(column.table.lower())
                continue

            for alias, real_table in tables.items():
                if column.name.lower() in self.schema[real_table]:
                    cond_tables.add(alias)

        return list(cond_tables)

    def _build_execution_plan(self, root_node_id: str, node_messages: Dict[str, str]) -> List[str]:
        children_map = {node["id"]: [] for node in self.nodes}
        for edge in self.edges:
            children_map.setdefault(edge["target"], []).append(edge["source"])
            children_map.setdefault(edge["source"], [])

        subtree_height_cache: Dict[str, int] = {}
        subtree_size_cache: Dict[str, int] = {}

        def subtree_height(node_id: str) -> int:
            if node_id in subtree_height_cache:
                return subtree_height_cache[node_id]

            children = children_map.get(node_id, [])
            if not children:
                subtree_height_cache[node_id] = 0
                return 0

            height = 1 + max(subtree_height(child_id) for child_id in children)
            subtree_height_cache[node_id] = height
            return height

        def subtree_size(node_id: str) -> int:
            if node_id in subtree_size_cache:
                return subtree_size_cache[node_id]

            size = 1 + sum(subtree_size(child_id) for child_id in children_map.get(node_id, []))
            subtree_size_cache[node_id] = size
            return size

        def child_sort_key(node_id: str) -> tuple[int, int, int]:
            return (-subtree_height(node_id), -subtree_size(node_id), int(node_id))

        ordered_messages: List[str] = []
        visited = set()

        def visit(node_id: str):
            if node_id in visited:
                return

            visited.add(node_id)
            for child_id in sorted(children_map.get(node_id, []), key=child_sort_key):
                visit(child_id)

            message = node_messages.get(node_id)
            if message:
                ordered_messages.append(message)

        visit(root_node_id)
        return [f"Passo {index}: {message}" for index, message in enumerate(ordered_messages, start=1)]

    def process(self, query: str) -> Dict[str, Any]:
        self.nodes = []
        self.edges = []
        self.node_counter = 0
        node_messages: Dict[str, str] = {}

        try:
            ast = sqlglot.parse_one(query)
            if not isinstance(ast, exp.Select):
                raise ValueError("Suporte provido somente para consultas SELECT.")
        except Exception as exc:
            raise ValueError(f"Erro de sintaxe SQL ou nao suportada: {str(exc)}") from exc

        tables_in_query: Dict[str, str] = {}
        for table in ast.find_all(exp.Table):
            real_name = table.name.lower()
            alias = table.alias.lower() if table.alias else real_name
            self._validate_table_exists(real_name)
            tables_in_query[alias] = real_name

        branches: Dict[str, str] = {}
        for alias, table_real in tables_in_query.items():
            node_label = f"Tabela: {table_real}" + (f" ({alias})" if alias != table_real else "")
            node_id = self._add_node(node_label, "table")
            branches[alias] = node_id
            node_messages[node_id] = f"Ler dados da tabela '{table_real}'" + (
                f" como '{alias}'." if alias != table_real else "."
            )

        conditions: List[exp.Expression] = []

        def get_ands(node: exp.Expression) -> List[exp.Expression]:
            if isinstance(node, exp.And):
                return get_ands(node.left) + get_ands(node.right)
            return [node]

        if ast.args.get("where"):
            conditions.extend(get_ands(ast.args["where"].this))

        for join in ast.args.get("joins", []):
            if join.args.get("on"):
                conditions.extend(get_ands(join.args["on"]))

        single_table_conds = {alias: [] for alias in tables_in_query}
        multi_table_conds: List[exp.Expression] = []

        for cond in conditions:
            cond_tables = self._get_tables_for_cond(cond, tables_in_query)
            if len(cond_tables) == 1:
                alias = cond_tables[0]
                if alias in single_table_conds:
                    single_table_conds[alias].append(cond)
                else:
                    multi_table_conds.append(cond)
            else:
                multi_table_conds.append(cond)

        for alias, conds in single_table_conds.items():
            if not conds:
                continue

            cond_str = " AND ".join(cond.sql() for cond in conds)
            sigma_node = self._add_node(f"{SIGMA} ({cond_str})", "selection")
            self._add_edge(branches[alias], sigma_node)
            branches[alias] = sigma_node
            node_messages[sigma_node] = (
                f"Otimizacao (Reducao de Tuplas): Aplicar selecao {SIGMA}({cond_str}) diretamente na tabela '{alias}'."
            )

        used_cols_per_alias = {alias: set() for alias in tables_in_query}
        has_star = any(isinstance(expression, exp.Star) for expression in ast.expressions)

        if not has_star:
            for column in ast.find_all(exp.Column):
                alias = column.table.lower() if column.table else None
                if not alias:
                    for candidate_alias, real_table in tables_in_query.items():
                        if column.name.lower() in self.schema[real_table]:
                            alias = candidate_alias
                            break

                if alias in used_cols_per_alias:
                    used_cols_per_alias[alias].add(column.name.lower())

            for alias, cols in used_cols_per_alias.items():
                if not cols:
                    continue

                cols_str = ", ".join(sorted(cols))
                pi_node = self._add_node(f"{PI} ({cols_str})", "projection")
                self._add_edge(branches[alias], pi_node)
                branches[alias] = pi_node
                node_messages[pi_node] = (
                    f"Otimizacao (Reducao de Atributos): Projetar antecipadamente {PI}({cols_str}) na tabela '{alias}'."
                )

        aliases_to_join = list(branches.keys())
        current_node_id = branches[aliases_to_join[0]]
        joined_aliases = [aliases_to_join.pop(0)]

        while aliases_to_join:
            best_alias = None
            best_conds: List[exp.Expression] = []
            best_idx = 0

            for index, alias in enumerate(aliases_to_join):
                join_conds = []
                for cond in list(multi_table_conds):
                    cond_tables = self._get_tables_for_cond(cond, tables_in_query)
                    if alias in cond_tables and any(joined_alias in cond_tables for joined_alias in joined_aliases):
                        join_conds.append(cond)

                if join_conds:
                    best_alias = alias
                    best_conds = join_conds
                    best_idx = index
                    break

            if best_alias is None:
                best_alias = aliases_to_join[0]
                best_conds = []
                best_idx = 0

            aliases_to_join.pop(best_idx)

            join_label = JOIN
            if best_conds:
                cond_str = " AND ".join(cond.sql() for cond in best_conds)
                join_label += f" ({cond_str})"
                for cond in best_conds:
                    if cond in multi_table_conds:
                        multi_table_conds.remove(cond)
                join_message = f"Sincronizar (Juncao) dados com '{best_alias}' utilizando a condicao '{cond_str}'."
            else:
                join_label += " (Produto Cartesiano!)"
                join_message = (
                    f"Sincronizar (Produto Cartesiano) dados com '{best_alias}' "
                    "(Alerta: Otimizacao Evitada!)."
                )

            join_node = self._add_node(join_label, "join")
            self._add_edge(current_node_id, join_node)
            self._add_edge(branches[best_alias], join_node)
            current_node_id = join_node
            joined_aliases.append(best_alias)
            node_messages[join_node] = join_message

        if multi_table_conds:
            cond_str = " AND ".join(cond.sql() for cond in multi_table_conds)
            sigma_node = self._add_node(f"{SIGMA} ({cond_str})", "selection")
            self._add_edge(current_node_id, sigma_node)
            current_node_id = sigma_node
            node_messages[sigma_node] = f"Aplicar filtros globais multi-tabelas {SIGMA}({cond_str})."

        projections = [expression.sql() for expression in ast.expressions]
        proj_str = ", ".join(projections)
        proj_node = self._add_node(f"{PI} ({proj_str})", "projection")
        self._add_edge(current_node_id, proj_node)
        node_messages[proj_node] = f"Finalizar preparando a vista com a projecao ({PI}) da consulta: {proj_str}."

        algebra_expr = "Multiplas transformacoes executadas (Arvore Otimizada)"
        exec_plan = self._build_execution_plan(proj_node, node_messages)

        return {
            "nodes": self.nodes,
            "edges": self.edges,
            "algebra": algebra_expr,
            "execution_plan": exec_plan,
        }
