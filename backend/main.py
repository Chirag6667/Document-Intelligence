from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path
from threading import Lock
from uuid import uuid4

import chromadb
import torch
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel, Field
from pypdf import PdfReader
from transformers import AutoModel, AutoTokenizer


app = FastAPI(title="Backend API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CHUNK_SIZE = 350
CHUNK_OVERLAP = 70
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
CHROMA_PATH = Path(__file__).parent / "chroma_db"

# Load local defaults without replacing container/runtime environment variables.
load_dotenv(dotenv_path=Path(__file__).parent / ".env")

chroma_client = chromadb.PersistentClient(path=str(CHROMA_PATH))
collection = chroma_client.get_or_create_collection(name="document_chunks")

_model_lock = Lock()
_tokenizer = None
_model = None
_groq_client = None


class QueryRequest(BaseModel):
    question: str = Field(min_length=1, description="Question to answer from uploaded documents")


def split_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into fixed-size character chunks with overlapping context."""
    if chunk_size <= 0 or overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be non-negative and smaller than chunk_size")

    return [text[start : start + chunk_size] for start in range(0, len(text), chunk_size - overlap)]


def get_embedding_model():
    """Load the Hugging Face tokenizer and model once, on the first upload."""
    global _tokenizer, _model

    with _model_lock:
        if _tokenizer is None or _model is None:
            _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
            _model = AutoModel.from_pretrained(MODEL_NAME)
            _model.eval()

    return _tokenizer, _model


def embed_chunks(chunks: list[str]) -> list[list[float]]:
    """Create normalized mean-pooled all-MiniLM-L6-v2 embeddings via transformers."""
    tokenizer, model = get_embedding_model()
    encoded = tokenizer(chunks, padding=True, truncation=True, return_tensors="pt")

    with torch.no_grad():
        token_embeddings = model(**encoded).last_hidden_state
        mask = encoded["attention_mask"].unsqueeze(-1).expand(token_embeddings.size()).float()
        embeddings = (token_embeddings * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
        embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)

    return embeddings.cpu().tolist()


def get_groq_client() -> Groq:
    """Create the Groq client only when a query requires it."""
    global _groq_client

    if _groq_client is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise HTTPException(status_code=500, detail="GROQ_API_KEY is not configured")
        _groq_client = Groq(api_key=api_key)

    return _groq_client


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Return the API health status."""
    return {"status": "ok"}


@app.post("/query")
async def query_documents(request: QueryRequest) -> dict[str, object]:
    """Answer a question using only the five most relevant stored document chunks."""
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="question must not be blank")

    result_count = min(5, collection.count())
    if result_count == 0:
        return {"answer": "I don't know based on the provided context.", "sources": []}

    results = collection.query(
        query_embeddings=embed_chunks([question]),
        n_results=result_count,
        include=["documents", "metadatas"],
    )
    documents = results["documents"][0]
    metadatas = results["metadatas"][0]
    sources = [
        {"filename": metadata["filename"], "chunk_index": metadata["chunk_index"]}
        for metadata in metadatas
    ]
    context = "\n\n".join(
        f"[Source {index}: {metadata['filename']}, chunk {metadata['chunk_index']}]\n{document}"
        for index, (document, metadata) in enumerate(zip(documents, metadatas), start=1)
    )

    prompt = f"""Use only the context below to answer the question. Do not use outside knowledge or make up information. If the answer is not contained in the context, say: \"I don't know based on the provided context.\"

Context:
---
{context}
---

Question: {question}
Answer:"""

    try:
        completion = get_groq_client().chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="Unable to generate an answer from Groq") from error

    return {
        "answer": completion.choices[0].message.content or "I don't know based on the provided context.",
        "sources": sources,
    }


@app.post("/upload")
async def upload_document(file: UploadFile = File(...)) -> dict[str, str | int]:
    """Extract text, chunk it, embed its chunks, and persist them in ChromaDB."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="A filename is required")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".txt", ".md", ".pdf"}:
        raise HTTPException(status_code=400, detail="Only .txt, .md, and .pdf files are supported")

    try:
        contents = await file.read()
        if suffix == ".pdf":
            text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(contents)).pages)
        else:
            text = contents.decode("utf-8")
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=400, detail="The file must be UTF-8 encoded text") from error
    except Exception as error:
        if suffix == ".pdf":
            raise HTTPException(status_code=400, detail="The PDF could not be read") from error
        raise

    chunks = split_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="The uploaded file is empty")

    document_id = str(uuid4())
    chunk_ids = [f"{document_id}:{index}" for index in range(len(chunks))]
    step = CHUNK_SIZE - CHUNK_OVERLAP
    collection.add(
        ids=chunk_ids,
        documents=chunks,
        embeddings=embed_chunks(chunks),
        metadatas=[
            {
                "document_id": document_id,
                "filename": file.filename,
                "chunk_index": index,
                "start_char": index * step,
                "end_char": min(index * step + CHUNK_SIZE, len(text)),
            }
            for index in range(len(chunks))
        ],
    )

    return {
        "document_id": document_id,
        "filename": file.filename,
        "chunks_stored": len(chunks),
    }
