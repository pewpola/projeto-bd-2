import sqlglot
from sqlglot import exp
from schema import SCHEMA
from typing import List, Dict, Any, Tuple

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

    def _get_tables_for_cond(self, cond, tables):
        cols = list(cond.find_all(exp.Column))
        cond_tables = set()
        for c in cols:
            if c.table:
                cond_tables.add(c.table.lower())
            else:
                for a, r in tables.items():
                    if c.name.lower() in self.schema[r]:
                        cond_tables.add(a)
        return list(cond_tables)

    def process(self, query: str) -> Dict[str, Any]:
        self.nodes = []
        self.edges = []
        self.node_counter = 0
        exec_plan = []
        
        step_count = 1
        def add_step(msg):
            nonlocal step_count
            exec_plan.append(f"Passo {step_count}: {msg}")
            step_count += 1

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
            
        branches = {}
        for alias, table_real in tables_in_query.items():
            node_label = f"Tabela: {table_real}" + (f" ({alias})" if alias != table_real else "")
            node_id = self._add_node(node_label)
            branches[alias] = node_id
            add_step(f"Ler dados da tabela '{table_real}'" + (f" como '{alias}'." if alias != table_real else "."))

        # Capturar Todas as Condições
        conditions = []
        
        def get_ands(node):
            if isinstance(node, exp.And):
                return get_ands(node.left) + get_ands(node.right)
            return [node]

        if ast.args.get('where'):
            conditions.extend(get_ands(ast.args['where'].this))
            
        for join in ast.args.get('joins', []):
            if join.args.get('on'):
                conditions.extend(get_ands(join.args['on']))
                
        single_table_conds = {alias: [] for alias in tables_in_query}
        multi_table_conds = []

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

        # 1. Heurística: Pushdown de Seleções (Condições isoladas empurradas pra baixo)
        for alias, conds in single_table_conds.items():
            if conds:
                cond_str = " AND ".join([c.sql() for c in conds])
                sigma_node = self._add_node(f"σ ({cond_str})")
                self._add_edge(branches[alias], sigma_node)
                branches[alias] = sigma_node
                add_step(f"Otimização (Redução de Tuplas): Aplicar seleção σ({cond_str}) diretamente na tabela '{alias}'.")

        # 2. Heurística: Pushdown de Projeções (Pegar apenas os atributos necessários)
        used_cols_per_alias = {alias: set() for alias in tables_in_query}
        has_star = False
        for e in ast.expressions:
            if isinstance(e, exp.Star):
                has_star = True

        if not has_star:
            for c in ast.find_all(exp.Column):
                alias = c.table.lower() if c.table else None
                if not alias:
                    for a, r in tables_in_query.items():
                        if c.name.lower() in self.schema[r]:
                            alias = a
                            break
                if alias in used_cols_per_alias:
                    used_cols_per_alias[alias].add(c.name.lower())
                    
            for alias, cols in used_cols_per_alias.items():
                if cols:
                    cols_str = ", ".join(cols)
                    pi_node = self._add_node(f"π ({cols_str})")
                    self._add_edge(branches[alias], pi_node)
                    branches[alias] = pi_node
                    add_step(f"Otimização (Redução de Atributos): Projetar antecipadamente π({cols_str}) na tabela '{alias}'.")

        # 3. Otimização de Junções
        aliases_to_join = list(branches.keys())
        current_node_id = branches[aliases_to_join[0]]
        joined_aliases = [aliases_to_join.pop(0)]

        while aliases_to_join:
            best_alias = None
            best_conds = []
            best_idx = 0

            for i, alias in enumerate(aliases_to_join):
                join_conds = []
                for c in list(multi_table_conds):
                    c_tables = self._get_tables_for_cond(c, tables_in_query)
                    if alias in c_tables and any(a in joined_aliases for a in c_tables):
                        join_conds.append(c)
                if join_conds:
                    best_alias = alias
                    best_conds = join_conds
                    best_idx = i
                    break
            
            if best_alias is None:
                best_alias = aliases_to_join[0]
                best_conds = []
                best_idx = 0
                
            aliases_to_join.pop(best_idx)
            
            join_str = "⨝"
            if best_conds:
                cond_str = " AND ".join([c.sql() for c in best_conds])
                join_str += f" ({cond_str})"
                add_step(f"Sincronizar (Junção) dados com '{best_alias}' utilizando a condição '{cond_str}'.")
                for c in best_conds:
                    if c in multi_table_conds:
                        multi_table_conds.remove(c)
            else:
                join_str += " (Produto Cartesiano!)"
                add_step(f"Sincronizar (Produto Cartesiano) dados com '{best_alias}' (Alerta: Otimização Evitada!).")

            join_node = self._add_node(join_str)
            self._add_edge(current_node_id, join_node)
            self._add_edge(branches[best_alias], join_node)
            current_node_id = join_node
            joined_aliases.append(best_alias)

        if multi_table_conds:
            cond_str = " AND ".join([c.sql() for c in multi_table_conds])
            sigma_node = self._add_node(f"σ ({cond_str})")
            self._add_edge(current_node_id, sigma_node)
            current_node_id = sigma_node
            add_step(f"Aplicar Filtros Globais multi-tabelas σ({cond_str}).")

        projections = [e.sql() for e in ast.expressions]
        proj_str = ", ".join(projections)
        proj_node = self._add_node(f"π ({proj_str})")
        self._add_edge(current_node_id, proj_node)
        add_step(f"Finalizar preparando a vista com a Projeção (π) da Consulta: {proj_str}.")

        algebra_expr = "Múltiplas transformações executadas (Árvore Otimizada)"

        return {
            "nodes": self.nodes,
            "edges": self.edges,
            "algebra": algebra_expr,
            "execution_plan": exec_plan
        }
