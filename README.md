# Processador de Consultas SQL

Aplicação educacional para analisar consultas SQL `SELECT`, convertê-las em álgebra relacional e comparar duas visões do plano:

- `Árvore Algébrica Original`
- `Árvore Algébrica Otimizada`

A interface mostra as duas árvores lado a lado, com grafo interativo e plano de execução textual.

## Stack

- Backend: `FastAPI`, `sqlglot`, `uvicorn`
- Frontend: `React`, `TypeScript`, `Vite`, `React Flow`

## O que a aplicação faz

- valida as tabelas da consulta contra o esquema do projeto
- monta a `Árvore Algébrica Original`
- monta a `Árvore Algébrica Otimizada`
- gera a ordem de execução percorrendo do nó mais profundo até a raiz
- organiza o grafo para evitar sobreposição dos nós
- apresenta um comparativo rápido entre quantidade de nós e etapas

## Estrutura

```text
backend/
  main.py         API FastAPI
  processor.py    parsing, transformação algébrica e geração dos planos
  schema.py       esquema conhecido pela aplicação
frontend/
  src/App.tsx     interface principal e visualização dos grafos
  src/index.css   estilos globais da aplicação
run.sh            inicialização no Linux/macOS
run.ps1           inicialização no Windows
```

## Tabelas disponíveis

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

## Exemplo de consulta

```sql
SELECT c.Nome, prod.Nome, cat.Descricao
FROM cliente c
JOIN pedido p ON c.idCliente = p.Cliente_idCliente
JOIN pedido_has_produto php ON p.idPedido = php.Pedido_idPedido
JOIN produto prod ON php.Produto_idProduto = prod.idProduto
JOIN categoria cat ON prod.Categoria_idCategoria = cat.idCategoria
WHERE c.Nascimento > '2000-01-01'
```

## Como executar

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

Para reutilizar dependências já instaladas:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -SkipInstall
```

### Linux ou macOS

```bash
chmod +x run.sh
./run.sh
```

Para reutilizar dependências já instaladas:

```bash
./run.sh --skip-install
```

### Execução manual

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8081
```

No Windows, a ativação do ambiente virtual pode ser feita com:

```powershell
.\.venv\Scripts\Activate.ps1
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Endereços padrão

- Frontend: `http://localhost:3001`
- Backend: `http://localhost:8081`

## Observações

- O backend aceita apenas consultas `SELECT`.
- A árvore otimizada pode ter mais nós que a original, porque explicita seleções e projeções antecipadas.
- A resposta da API mantém os campos atuais de comparação e também os campos legados do plano otimizado.
