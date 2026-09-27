# Document Intelligence

A document question-and-answer application. Upload a TXT, Markdown, or PDF file, then ask questions answered from the document's indexed content.

## Architecture

- **Frontend:** React + Vite. The production build is served by Nginx on port `5173`.
- **Backend:** FastAPI + Uvicorn. It creates embeddings with Transformers, stores document chunks in ChromaDB, and uses Groq to generate answers.
- **Container networking:** Nginx proxies browser requests from `/api/*` to the `backend` Compose service. This keeps the API same-origin in Docker; the ChromaDB directory is stored in a named Docker volume.

## Run with Docker

1. Create a `.env` file at the project root and add your Groq API key:

   ```env
   GROQ_API_KEY=your_groq_api_key
   ```

2. Start the whole application:

   ```sh
   docker compose up --build
   ```

3. Open [http://localhost:5173](http://localhost:5173).

The first document upload downloads the embedding model, so it can take a little longer. The API health endpoint is available at [http://localhost:8000/health](http://localhost:8000/health).

Stop the app with `docker compose down`. Add `-v` to that command if you also want to remove the saved document index.

## Local development

The frontend reads `VITE_API_URL`; when it is unset, it defaults to `http://127.0.0.1:8000`, which works with Vite's development server. To target a different backend, create `frontend/.env`:

```env
VITE_API_URL=http://127.0.0.1:8000
```
