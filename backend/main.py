from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from processor import SQLProcessor
from schema import SCHEMA

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

processor = SQLProcessor(SCHEMA)


class QueryRequest(BaseModel):
    query: str


@app.post("/api/parse")
async def parse_query(request: QueryRequest):
    try:
        result = processor.process(request.query)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Erro interno: {str(exc)}")
