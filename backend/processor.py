from collections import defaultdict
from typing import Any, Dict, List, TypedDict

import sqlglot
from sqlglot import exp

SIGMA = "σ"
PI = "π"
JOIN = "⨝"


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
    projected_cols_per_alias: Dict[str, List[str]]
    table_order: List[str]
    tables_in_query: Dict[str, str]
    where_conditions: List[exp.Expression]


class SQLProcessor:
    def __init__(self, schema: Dict[str, Dict[str, str]]):
        self.schema = {table.lower(): {column.lower(): kind for column, kind in columns.items()} for table, columns in schema.items()}

    def _validate_table_exists(self, table_name: str):
        if table_name.lower() not in self.schema:
            raise ValueError(f"Tabela '{table_name}' não encontrada no esquema.")

    def _new_state(self) -> Dict[str, Any]:
        return {"edges": [], "node_counter": 0, "node_messages": {}, "nodes": []}

    def _add_node(self, state: Dict[str, Any], label: str, kind: str = "operation") -> str:
        state["node_counter"] += 1
        node_id = str(state["node_counter"])
        state["nodes"].append({
            "id": node_id,
            "data": {"label": label, "kind": kind},
            "position": {"x": 0, "y": 0},
        })
        return node_id

    def _connect(self, state: Dict[str, Any], source: str, target: str):
        state["edges"].append({"id": f"e{source}-{target}", "source": source, "target": target, "animated": True})

    def _flatten_ands(self, node: exp.Expression | None) -> List[exp.Expression]:
        if node is None:
            return []
        if isinstance(node, exp.And):
            return self._flatten_ands(node.left) + self._flatten_ands(node.right)
        return [node]

    def _condition_sql(self, conditions: List[exp.Expression]) -> str:
        return " AND ".join(condition.sql() for condition in conditions)

    def _table_label(self, alias: str, real_name: str) -> str:
        return f"Tabela: {real_name}" + (f" ({alias})" if alias != real_name else "")

    def _table_message(self, alias: str, real_name: str) -> str:
        return f"Ler dados da tabela '{real_name}'" + (f" como '{alias}'." if alias != real_name else ".")

    def _join_details(self, alias: str, conditions: List[exp.Expression]) -> tuple[str, str]:
        if conditions:
            cond_sql = self._condition_sql(conditions)
            return (
                f"{JOIN} ({cond_sql})",
                f"Executar junção com '{alias}' utilizando a condição '{cond_sql}'.",
            )

        return (
            f"{JOIN} (Produto Cartesiano!)",
            f"Executar produto cartesiano com '{alias}' (alerta: nenhuma condição de junção foi encontrada).",
        )

    def _push_unary_node(
        self,
        state: Dict[str, Any],
        source_id: str,
        label: str,
        kind: str,
        message: str,
    ) -> str:
        node_id = self._add_node(state, label, kind)
        self._connect(state, source_id, node_id)
        state["node_messages"][node_id] = message
        return node_id

    def _push_join_node(
        self,
        state: Dict[str, Any],
        left_id: str,
        right_id: str,
        alias: str,
        conditions: List[exp.Expression],
    ) -> str:
        label, message = self._join_details(alias, conditions)
        node_id = self._add_node(state, label, "join")
        self._connect(state, left_id, node_id)
        self._connect(state, right_id, node_id)
        state["node_messages"][node_id] = message
        return node_id

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

        height_cache: Dict[str, int] = {}
        size_cache: Dict[str, int] = {}

        def subtree_height(node_id: str) -> int:
            if node_id in height_cache:
                return height_cache[node_id]

            children = children_map.get(node_id, [])
            height_cache[node_id] = 0 if not children else 1 + max(subtree_height(child) for child in children)
            return height_cache[node_id]

        def subtree_size(node_id: str) -> int:
            if node_id in size_cache:
                return size_cache[node_id]

            size_cache[node_id] = 1 + sum(subtree_size(child) for child in children_map.get(node_id, []))
            return size_cache[node_id]

        def sort_key(node_id: str) -> tuple[int, int, int]:
            return (-subtree_height(node_id), -subtree_size(node_id), int(node_id))

        ordered_messages: List[str] = []
        visited = set()

        def visit(node_id: str):
            if node_id in visited:
                return

            visited.add(node_id)
            for child_id in sorted(children_map.get(node_id, []), key=sort_key):
                visit(child_id)

            if message := node_messages.get(node_id):
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

    def _extract_table_ref(self, table_expr: exp.Expression) -> TableRef:
        if not isinstance(table_expr, exp.Table):
            raise ValueError("Há suporte apenas para tabelas simples no FROM e nos JOINs.")

        real_name = table_expr.name.lower()
        alias = table_expr.alias.lower() if table_expr.alias else real_name
        self._validate_table_exists(real_name)
        return {"alias": alias, "real_name": real_name}

    def _register_table(self, tables_in_query: Dict[str, str], table_order: List[str], table_ref: TableRef):
        alias = table_ref["alias"]
        if alias in tables_in_query:
            raise ValueError(f"O alias '{alias}' foi declarado mais de uma vez na consulta.")

        tables_in_query[alias] = table_ref["real_name"]
        table_order.append(alias)

    def _resolve_column_alias(self, column: exp.Column, tables_in_query: Dict[str, str]) -> str | None:
        if column.table:
            return column.table.lower()

        for alias, real_table in tables_in_query.items():
            if column.name.lower() in self.schema[real_table]:
                return alias

        return None

    def _collect_columns_from_expressions(
        self,
        expressions: List[exp.Expression],
        tables_in_query: Dict[str, str],
    ) -> Dict[str, List[str]]:
        used_columns = {alias: set() for alias in tables_in_query}

        for expression in expressions:
            for column in expression.find_all(exp.Column):
                if alias := self._resolve_column_alias(column, tables_in_query):
                    used_columns[alias].add(column.name.lower())

        return {alias: sorted(columns) for alias, columns in used_columns.items()}

    def _collect_projected_columns(
        self,
        ast: exp.Select,
        all_conditions: List[exp.Expression],
        tables_in_query: Dict[str, str],
    ) -> Dict[str, List[str]]:
        later_conditions = [
            condition
            for condition in all_conditions
            if len(self._tables_for_condition(condition, tables_in_query)) > 1
        ]
        return self._collect_columns_from_expressions(
            [*ast.expressions, *later_conditions],
            tables_in_query,
        )

    def _tables_for_condition(self, condition: exp.Expression, tables_in_query: Dict[str, str]) -> List[str]:
        aliases = set()
        for column in condition.find_all(exp.Column):
            if alias := self._resolve_column_alias(column, tables_in_query):
                aliases.add(alias)
        return list(aliases)

    def _extract_query_context(self, ast: exp.Select) -> QueryContext:
        from_clause = ast.args.get("from_")
        if not isinstance(from_clause, exp.From) or from_clause.this is None:
            raise ValueError("A consulta precisa referenciar pelo menos uma tabela do esquema.")

        tables_in_query: Dict[str, str] = {}
        table_order: List[str] = []
        self._register_table(tables_in_query, table_order, self._extract_table_ref(from_clause.this))

        join_sequence: List[JoinRef] = []
        all_conditions: List[exp.Expression] = []

        for join in ast.args.get("joins", []):
            join_table = self._extract_table_ref(join.this)
            self._register_table(tables_in_query, table_order, join_table)
            join_conditions = self._flatten_ands(join.args.get("on"))
            all_conditions.extend(join_conditions)
            join_sequence.append({**join_table, "conditions": join_conditions})

        where_conditions = self._flatten_ands(ast.args.get("where").this if ast.args.get("where") else None)
        all_conditions.extend(where_conditions)

        return {
            "all_conditions": all_conditions,
            "ast": ast,
            "has_star": any(isinstance(expression, exp.Star) for expression in ast.expressions),
            "join_sequence": join_sequence,
            "projections": [expression.sql() for expression in ast.expressions],
            "projected_cols_per_alias": self._collect_projected_columns(ast, all_conditions, tables_in_query),
            "table_order": table_order,
            "tables_in_query": tables_in_query,
            "where_conditions": where_conditions,
        }

    def _build_table_branches(self, state: Dict[str, Any], context: QueryContext) -> Dict[str, str]:
        branches: Dict[str, str] = {}
        for alias in context["table_order"]:
            real_name = context["tables_in_query"][alias]
            node_id = self._add_node(state, self._table_label(alias, real_name), "table")
            branches[alias] = node_id
            state["node_messages"][node_id] = self._table_message(alias, real_name)
        return branches

    def _split_conditions(self, context: QueryContext) -> tuple[Dict[str, List[exp.Expression]], List[exp.Expression]]:
        single_table = defaultdict(list)
        multi_table: List[exp.Expression] = []

        for condition in context["all_conditions"]:
            tables = self._tables_for_condition(condition, context["tables_in_query"])
            if len(tables) == 1:
                single_table[tables[0]].append(condition)
            else:
                multi_table.append(condition)

        return ({alias: single_table.get(alias, []) for alias in context["table_order"]}, multi_table)

    def _pick_next_join(
        self,
        pending_aliases: List[str],
        joined_aliases: List[str],
        conditions: List[exp.Expression],
        tables_in_query: Dict[str, str],
    ) -> tuple[str, List[exp.Expression]]:
        for index, alias in enumerate(pending_aliases):
            matched = []
            for condition in conditions:
                condition_tables = self._tables_for_condition(condition, tables_in_query)
                if alias in condition_tables and any(joined in condition_tables for joined in joined_aliases):
                    matched.append(condition)

            if matched:
                pending_aliases.pop(index)
                for condition in matched:
                    conditions.remove(condition)
                return alias, matched

        return pending_aliases.pop(0), []

    def _build_original_plan(self, context: QueryContext) -> Dict[str, Any]:
        state = self._new_state()
        branches = self._build_table_branches(state, context)
        current_node = branches[context["table_order"][0]]

        for join_ref in context["join_sequence"]:
            current_node = self._push_join_node(
                state,
                current_node,
                branches[join_ref["alias"]],
                join_ref["alias"],
                join_ref["conditions"],
            )

        if context["where_conditions"]:
            cond_sql = self._condition_sql(context["where_conditions"])
            current_node = self._push_unary_node(
                state,
                current_node,
                f"{SIGMA} ({cond_sql})",
                "selection",
                f"Aplicar a seleção global {SIGMA}({cond_sql}) após as junções.",
            )

        projection_sql = ", ".join(context["projections"])
        root_node = self._push_unary_node(
            state,
            current_node,
            f"{PI} ({projection_sql})",
            "projection",
            f"Finalizar a consulta com a projeção ({PI}) dos atributos: {projection_sql}.",
        )
        return self._finalize_plan(state, root_node, "Árvore algébrica original gerada com sucesso.")

    def _build_optimized_plan(self, context: QueryContext) -> Dict[str, Any]:
        state = self._new_state()
        branches = self._build_table_branches(state, context)
        single_table_conditions, multi_table_conditions = self._split_conditions(context)

        for alias, conditions in single_table_conditions.items():
            if not conditions:
                continue

            cond_sql = self._condition_sql(conditions)
            branches[alias] = self._push_unary_node(
                state,
                branches[alias],
                f"{SIGMA} ({cond_sql})",
                "selection",
                f"Otimização (Redução de Tuplas): aplicar seleção {SIGMA}({cond_sql}) diretamente na tabela '{alias}'.",
            )

        if not context["has_star"]:
            for alias, columns in context["projected_cols_per_alias"].items():
                if not columns:
                    continue

                column_sql = ", ".join(columns)
                branches[alias] = self._push_unary_node(
                    state,
                    branches[alias],
                    f"{PI} ({column_sql})",
                    "projection",
                    f"Otimização (Redução de Atributos): projetar antecipadamente {PI}({column_sql}) na tabela '{alias}'.",
                )

        pending_aliases = context["table_order"][1:]
        joined_aliases = [context["table_order"][0]]
        current_node = branches[joined_aliases[0]]

        while pending_aliases:
            alias, join_conditions = self._pick_next_join(
                pending_aliases,
                joined_aliases,
                multi_table_conditions,
                context["tables_in_query"],
            )
            current_node = self._push_join_node(
                state,
                current_node,
                branches[alias],
                alias,
                join_conditions,
            )
            joined_aliases.append(alias)

        if multi_table_conditions:
            cond_sql = self._condition_sql(multi_table_conditions)
            current_node = self._push_unary_node(
                state,
                current_node,
                f"{SIGMA} ({cond_sql})",
                "selection",
                f"Aplicar filtros globais entre múltiplas tabelas {SIGMA}({cond_sql}).",
            )

        projection_sql = ", ".join(context["projections"])
        root_node = self._push_unary_node(
            state,
            current_node,
            f"{PI} ({projection_sql})",
            "projection",
            f"Finalizar a consulta com a projeção ({PI}) dos atributos: {projection_sql}.",
        )
        return self._finalize_plan(state, root_node, "Árvore algébrica otimizada gerada com sucesso.")

    def process(self, query: str) -> Dict[str, Any]:
        try:
            ast = sqlglot.parse_one(query)
            if not isinstance(ast, exp.Select):
                raise ValueError("Há suporte apenas para consultas SELECT.")
        except Exception as exc:
            raise ValueError(f"Erro de sintaxe SQL ou consulta não suportada: {exc}") from exc

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
