from typing import Any, Dict, List, TypedDict

import sqlglot
from sqlglot import exp

SIGMA = "\u03c3"
PI = "\u03c0"
JOIN = "\u2a1d"


class TableRef(TypedDict):
    alias: str
    real_name: str


class JoinRef(TypedDict):
    alias: str
    real_name: str
    conditions: List[exp.Expression]


class QueryContext(TypedDict):
    all_conditions: List[exp.Expression]
    ast: exp.Select
    has_star: bool
    join_sequence: List[JoinRef]
    projections: List[str]
    table_order: List[str]
    tables_in_query: Dict[str, str]
    used_cols_per_alias: Dict[str, List[str]]
    where_conditions: List[exp.Expression]


class SQLProcessor:
    def __init__(self, schema: Dict[str, Dict[str, str]]):
        self.schema = {k.lower(): {c.lower(): t for c, t in v.items()} for k, v in schema.items()}

    def _validate_table_exists(self, table_name: str):
        if table_name.lower() not in self.schema:
            raise ValueError(f"Tabela '{table_name}' n\u00e3o encontrada no esquema.")

    def _create_plan_state(self) -> Dict[str, Any]:
        return {
            "edges": [],
            "node_counter": 0,
            "node_messages": {},
            "nodes": [],
        }

    def _add_node(self, state: Dict[str, Any], label: str, kind: str = "operation") -> str:
        state["node_counter"] += 1
        node_id = str(state["node_counter"])
        state["nodes"].append({
            "id": node_id,
            "data": {"label": label, "kind": kind},
            "position": {"x": 0, "y": 0},
        })
        return node_id

    def _add_edge(self, state: Dict[str, Any], source: str, target: str):
        state["edges"].append({
            "id": f"e{source}-{target}",
            "source": source,
            "target": target,
            "animated": True,
        })

    def _build_execution_plan(
        self,
        nodes: List[Dict[str, Any]],
        edges: List[Dict[str, Any]],
        root_node_id: str,
        node_messages: Dict[str, str],
    ) -> List[str]:
        children_map = {node["id"]: [] for node in nodes}
        for edge in edges:
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

    def _finalize_plan(self, state: Dict[str, Any], root_node_id: str, algebra_expr: str) -> Dict[str, Any]:
        return {
            "nodes": state["nodes"],
            "edges": state["edges"],
            "algebra": algebra_expr,
            "execution_plan": self._build_execution_plan(
                state["nodes"],
                state["edges"],
                root_node_id,
                state["node_messages"],
            ),
        }

    def _get_ands(self, node: exp.Expression | None) -> List[exp.Expression]:
        if node is None:
            return []

        if isinstance(node, exp.And):
            return self._get_ands(node.left) + self._get_ands(node.right)

        return [node]

    def _extract_table_ref(self, table_expr: exp.Expression) -> TableRef:
        if not isinstance(table_expr, exp.Table):
            raise ValueError("H\u00e1 suporte apenas para tabelas simples no FROM e nos JOINs.")

        real_name = table_expr.name.lower()
        alias = table_expr.alias.lower() if table_expr.alias else real_name
        self._validate_table_exists(real_name)
        return {
            "alias": alias,
            "real_name": real_name,
        }

    def _register_table(self, tables_in_query: Dict[str, str], table_order: List[str], table_ref: TableRef):
        alias = table_ref["alias"]
        real_name = table_ref["real_name"]

        if alias in tables_in_query:
            raise ValueError(f"O alias '{alias}' foi declarado mais de uma vez na consulta.")

        tables_in_query[alias] = real_name
        table_order.append(alias)

    def _resolve_column_alias(self, column: exp.Column, tables_in_query: Dict[str, str]) -> str | None:
        if column.table:
            return column.table.lower()

        for alias, real_table in tables_in_query.items():
            if column.name.lower() in self.schema[real_table]:
                return alias

        return None

    def _collect_used_columns(self, ast: exp.Select, tables_in_query: Dict[str, str]) -> Dict[str, List[str]]:
        used_cols_per_alias = {alias: set() for alias in tables_in_query}

        for column in ast.find_all(exp.Column):
            alias = self._resolve_column_alias(column, tables_in_query)
            if alias in used_cols_per_alias:
                used_cols_per_alias[alias].add(column.name.lower())

        return {alias: sorted(columns) for alias, columns in used_cols_per_alias.items()}

    def _get_tables_for_cond(self, cond: exp.Expression, tables_in_query: Dict[str, str]) -> List[str]:
        cond_tables = set()

        for column in cond.find_all(exp.Column):
            alias = self._resolve_column_alias(column, tables_in_query)
            if alias:
                cond_tables.add(alias)

        return list(cond_tables)

    def _extract_query_context(self, ast: exp.Select) -> QueryContext:
        from_clause = ast.args.get("from_")
        if not isinstance(from_clause, exp.From) or from_clause.this is None:
            raise ValueError("A consulta precisa referenciar pelo menos uma tabela do esquema.")

        tables_in_query: Dict[str, str] = {}
        table_order: List[str] = []

        base_table = self._extract_table_ref(from_clause.this)
        self._register_table(tables_in_query, table_order, base_table)

        join_sequence: List[JoinRef] = []
        all_conditions: List[exp.Expression] = []

        for join in ast.args.get("joins", []):
            join_table = self._extract_table_ref(join.this)
            self._register_table(tables_in_query, table_order, join_table)

            join_conditions = self._get_ands(join.args.get("on"))
            all_conditions.extend(join_conditions)
            join_sequence.append({
                "alias": join_table["alias"],
                "real_name": join_table["real_name"],
                "conditions": join_conditions,
            })

        where_conditions = self._get_ands(ast.args.get("where").this if ast.args.get("where") else None)
        all_conditions.extend(where_conditions)

        return {
            "all_conditions": all_conditions,
            "ast": ast,
            "has_star": any(isinstance(expression, exp.Star) for expression in ast.expressions),
            "join_sequence": join_sequence,
            "projections": [expression.sql() for expression in ast.expressions],
            "table_order": table_order,
            "tables_in_query": tables_in_query,
            "used_cols_per_alias": self._collect_used_columns(ast, tables_in_query),
            "where_conditions": where_conditions,
        }

    def _build_original_plan(self, context: QueryContext) -> Dict[str, Any]:
        state = self._create_plan_state()
        branches: Dict[str, str] = {}

        for alias in context["table_order"]:
            table_real = context["tables_in_query"][alias]
            node_label = f"Tabela: {table_real}" + (f" ({alias})" if alias != table_real else "")
            node_id = self._add_node(state, node_label, "table")
            branches[alias] = node_id
            state["node_messages"][node_id] = f"Ler dados da tabela '{table_real}'" + (
                f" como '{alias}'." if alias != table_real else "."
            )

        current_node_id = branches[context["table_order"][0]]

        for join_ref in context["join_sequence"]:
            alias = join_ref["alias"]
            join_conditions = join_ref["conditions"]

            if join_conditions:
                cond_str = " AND ".join(cond.sql() for cond in join_conditions)
                join_label = f"{JOIN} ({cond_str})"
                join_message = (
                    f"Executar jun\u00e7\u00e3o com '{alias}' utilizando a condi\u00e7\u00e3o '{cond_str}'."
                )
            else:
                join_label = f"{JOIN} (Produto Cartesiano!)"
                join_message = (
                    f"Executar produto cartesiano com '{alias}' "
                    "(alerta: nenhuma condi\u00e7\u00e3o de jun\u00e7\u00e3o foi encontrada)."
                )

            join_node = self._add_node(state, join_label, "join")
            self._add_edge(state, current_node_id, join_node)
            self._add_edge(state, branches[alias], join_node)
            current_node_id = join_node
            state["node_messages"][join_node] = join_message

        if context["where_conditions"]:
            cond_str = " AND ".join(cond.sql() for cond in context["where_conditions"])
            sigma_node = self._add_node(state, f"{SIGMA} ({cond_str})", "selection")
            self._add_edge(state, current_node_id, sigma_node)
            current_node_id = sigma_node
            state["node_messages"][sigma_node] = (
                f"Aplicar a sele\u00e7\u00e3o global {SIGMA}({cond_str}) ap\u00f3s as jun\u00e7\u00f5es."
            )

        proj_str = ", ".join(context["projections"])
        proj_node = self._add_node(state, f"{PI} ({proj_str})", "projection")
        self._add_edge(state, current_node_id, proj_node)
        state["node_messages"][proj_node] = (
            f"Finalizar a consulta com a proje\u00e7\u00e3o ({PI}) dos atributos: {proj_str}."
        )

        return self._finalize_plan(state, proj_node, "\u00c1rvore alg\u00e9brica original gerada com sucesso.")

    def _build_optimized_plan(self, context: QueryContext) -> Dict[str, Any]:
        state = self._create_plan_state()
        branches: Dict[str, str] = {}

        for alias in context["table_order"]:
            table_real = context["tables_in_query"][alias]
            node_label = f"Tabela: {table_real}" + (f" ({alias})" if alias != table_real else "")
            node_id = self._add_node(state, node_label, "table")
            branches[alias] = node_id
            state["node_messages"][node_id] = f"Ler dados da tabela '{table_real}'" + (
                f" como '{alias}'." if alias != table_real else "."
            )

        single_table_conds = {alias: [] for alias in context["tables_in_query"]}
        multi_table_conds: List[exp.Expression] = []

        for cond in context["all_conditions"]:
            cond_tables = self._get_tables_for_cond(cond, context["tables_in_query"])
            if len(cond_tables) == 1:
                alias = cond_tables[0]
                if alias in single_table_conds:
                    single_table_conds[alias].append(cond)
                    continue

            multi_table_conds.append(cond)

        for alias, conds in single_table_conds.items():
            if not conds:
                continue

            cond_str = " AND ".join(cond.sql() for cond in conds)
            sigma_node = self._add_node(state, f"{SIGMA} ({cond_str})", "selection")
            self._add_edge(state, branches[alias], sigma_node)
            branches[alias] = sigma_node
            state["node_messages"][sigma_node] = (
                f"Otimiza\u00e7\u00e3o (Redu\u00e7\u00e3o de Tuplas): aplicar sele\u00e7\u00e3o "
                f"{SIGMA}({cond_str}) diretamente na tabela '{alias}'."
            )

        if not context["has_star"]:
            for alias, cols in context["used_cols_per_alias"].items():
                if not cols:
                    continue

                cols_str = ", ".join(cols)
                pi_node = self._add_node(state, f"{PI} ({cols_str})", "projection")
                self._add_edge(state, branches[alias], pi_node)
                branches[alias] = pi_node
                state["node_messages"][pi_node] = (
                    f"Otimiza\u00e7\u00e3o (Redu\u00e7\u00e3o de Atributos): projetar antecipadamente "
                    f"{PI}({cols_str}) na tabela '{alias}'."
                )

        aliases_to_join = list(branches.keys())
        current_node_id = branches[aliases_to_join[0]]
        joined_aliases = [aliases_to_join.pop(0)]

        while aliases_to_join:
            best_alias = aliases_to_join[0]
            best_conds: List[exp.Expression] = []
            best_idx = 0

            for index, alias in enumerate(aliases_to_join):
                join_conds = []
                for cond in list(multi_table_conds):
                    cond_tables = self._get_tables_for_cond(cond, context["tables_in_query"])
                    if alias in cond_tables and any(joined_alias in cond_tables for joined_alias in joined_aliases):
                        join_conds.append(cond)

                if join_conds:
                    best_alias = alias
                    best_conds = join_conds
                    best_idx = index
                    break

            aliases_to_join.pop(best_idx)

            if best_conds:
                cond_str = " AND ".join(cond.sql() for cond in best_conds)
                join_label = f"{JOIN} ({cond_str})"
                for cond in best_conds:
                    if cond in multi_table_conds:
                        multi_table_conds.remove(cond)
                join_message = (
                    f"Executar jun\u00e7\u00e3o com '{best_alias}' utilizando a condi\u00e7\u00e3o '{cond_str}'."
                )
            else:
                join_label = f"{JOIN} (Produto Cartesiano!)"
                join_message = (
                    f"Executar produto cartesiano com '{best_alias}' "
                    "(alerta: nenhuma condi\u00e7\u00e3o de jun\u00e7\u00e3o foi encontrada)."
                )

            join_node = self._add_node(state, join_label, "join")
            self._add_edge(state, current_node_id, join_node)
            self._add_edge(state, branches[best_alias], join_node)
            current_node_id = join_node
            joined_aliases.append(best_alias)
            state["node_messages"][join_node] = join_message

        if multi_table_conds:
            cond_str = " AND ".join(cond.sql() for cond in multi_table_conds)
            sigma_node = self._add_node(state, f"{SIGMA} ({cond_str})", "selection")
            self._add_edge(state, current_node_id, sigma_node)
            current_node_id = sigma_node
            state["node_messages"][sigma_node] = (
                f"Aplicar filtros globais entre m\u00faltiplas tabelas {SIGMA}({cond_str})."
            )

        proj_str = ", ".join(context["projections"])
        proj_node = self._add_node(state, f"{PI} ({proj_str})", "projection")
        self._add_edge(state, current_node_id, proj_node)
        state["node_messages"][proj_node] = (
            f"Finalizar a consulta com a proje\u00e7\u00e3o ({PI}) dos atributos: {proj_str}."
        )

        return self._finalize_plan(state, proj_node, "\u00c1rvore alg\u00e9brica otimizada gerada com sucesso.")

    def process(self, query: str) -> Dict[str, Any]:
        try:
            ast = sqlglot.parse_one(query)
            if not isinstance(ast, exp.Select):
                raise ValueError("H\u00e1 suporte apenas para consultas SELECT.")
        except Exception as exc:
            raise ValueError(f"Erro de sintaxe SQL ou consulta n\u00e3o suportada: {str(exc)}") from exc

        context = self._extract_query_context(ast)
        original_plan = self._build_original_plan(context)
        optimized_plan = self._build_optimized_plan(context)

        comparison = {
            "original_node_count": len(original_plan["nodes"]),
            "optimized_node_count": len(optimized_plan["nodes"]),
            "original_step_count": len(original_plan["execution_plan"]),
            "optimized_step_count": len(optimized_plan["execution_plan"]),
        }

        return {
            "original": original_plan,
            "optimized": optimized_plan,
            "comparison": comparison,
            "nodes": optimized_plan["nodes"],
            "edges": optimized_plan["edges"],
            "algebra": optimized_plan["algebra"],
            "execution_plan": optimized_plan["execution_plan"],
        }
