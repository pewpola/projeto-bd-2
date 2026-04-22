# Processador de Consultas - SQL para Álgebra Relacional

Este projeto é uma ferramenta de cunho educacional para a disciplina de Banco de Dados, projetada para processar consultas SQL, validá-las em relação a um esquema de metadados de tabelas, convertê-las em Álgebra Relacional e, por fim, renderizar um **Grafo de Operadores (Plano de Execução)** na interface.

## 🛠️ Tecnologias Utilizadas

- **Backend:** Python + FastAPI + Uvicorn (para o servidor) e `sqlglot` (para validação e parsing da árvore sintática do SQL - AST).
- **Frontend:** React + TypeScript + Vite, usando `axios` para consumo da API e `reactflow` interligado com o `dagre` para roteamento ordenado do grafo gerado das operações algébricas.

---

## 🗄️ Esquema Disponível para Consultas

O validador já conhece as seguintes tabelas (case insensitive) oriundas da modelagem proposta no trabalho (Imagem 01):

- `cliente`
- `endereco`
- `pedido`
- `status`
- `pedido_has_produto`
- `produto`
- `categoria`
- `tipoendereco`
- `tipocliente`
- `telefone`

---

## 🔍 Exemplos de Consultas Suportadas

Na interface gráfica, cole os comandos SQL a seguir para testar o parseamento e a geração da visualização do grafo de algebra relacional.

**1. Consulta Simples (Projeção e Tabela):**

```sql
SELECT Nome, Email FROM cliente
```

**2. Consulta com Condição (Seleção $\sigma$):**

```sql
SELECT * FROM produto WHERE Preco > 100
```

**3. Consulta com Múltiplas Condições:**

```sql
SELECT Nome, Descricao FROM produto WHERE Preco > 10 AND QuantEstoque < 50
```

**4. Consulta com JOIN (Junção $\bowtie$):**

```sql
SELECT c.Nome, p.DataPedido
FROM cliente c
JOIN pedido p ON c.idCliente = p.Cliente_idCliente
```

**5. Consulta Complexa (Múltiplos JOINs e WHERE):**

```sql
SELECT c.Nome, cat.Descricao, prod.Nome
FROM cliente c
JOIN pedido p ON c.idCliente = p.Cliente_idCliente
JOIN pedido_has_produto php ON p.idPedido = php.Pedido_idPedido
JOIN produto prod ON php.Produto_idProduto = prod.idProduto
JOIN categoria cat ON prod.Categoria_idCategoria = cat.idCategoria
WHERE c.Nascimento > '2000-01-01'
```

_(O backend converte essa string em uma Árvore de Sintaxe Abstrata, valida as tabelas pelo esquema que criamos, monta as etapas algébricas gerando nós `$\pi$`, `$\sigma$`, `$\bowtie$` e exporta o grafo para organizar com o ReactFlow)._

---

## 🚀 Como Rodar o Projeto

É necessário utilizar **dois terminais**, um para executar a API (backend) e outro para a Interface (frontend).

### 1. Rodando o Backend (API na porta 8081)

Abra um terminal no diretório raiz do projeto e execute:

```bash
cd backend
python -m venv venv
source venv/bin/activate  # ou `venv\Scripts\activate` no Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8081
```

_O backend ficará escutando requisições em `http://localhost:8081`._

### 2. Rodando o Frontend (React na porta 3001)

Abra um novo terminal (paralelo ao do backend) no diretório raiz do projeto e execute:

```bash
cd frontend
npm run dev
```

_O frontend ficará disponível em `http://localhost:3001`._

Acesse `http://localhost:3001` no navegador. Digite as consultas SQL no campo de texto e clique em "Analisar Consulta". Você visualizará a formulação de álgebra relacional em texto, seguida da visualização hierárquica interativa pelo grafo de execução do plano embaixo.
