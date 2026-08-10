import { useRef, useState } from 'react'

// Vite exposes only variables prefixed with VITE_. The fallback keeps the
// existing local-development experience when no environment variable is set.
const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
const acceptedExtensions = ['txt', 'md', 'pdf']

function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.8 18-3.2-7.2L3 10.8 21 3Zm-11 10.8L14.2 9.6" /></svg>
}

function App() {
  const inputRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [upload, setUpload] = useState({ status: 'idle', progress: 0, file: null, message: '' })
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [isQuerying, setIsQuerying] = useState(false)

  const uploadFile = (file) => {
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!acceptedExtensions.includes(extension)) {
      setUpload({ status: 'error', progress: 0, file, message: 'Please choose a .txt, .md, or .pdf file.' })
      return
    }

    setUpload({ status: 'uploading', progress: 0, file, message: 'Preparing your document…' })
    const data = new FormData()
    data.append('file', file)
    const request = new XMLHttpRequest()
    request.open('POST', `${API_URL}/upload`)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUpload((current) => ({ ...current, progress: Math.round((event.loaded / event.total) * 100), message: 'Uploading document…' }))
      }
    }
    request.onload = () => {
      let response = {}
      try { response = JSON.parse(request.responseText) } catch { /* keep generic error */ }
      if (request.status >= 200 && request.status < 300) {
        setUpload({ status: 'success', progress: 100, file, message: `${response.chunks_stored ?? 'Your'} chunks are ready to search.` })
      } else {
        setUpload({ status: 'error', progress: 0, file, message: response.detail || 'We could not upload this document. Please try again.' })
      }
    }
    request.onerror = () => setUpload({ status: 'error', progress: 0, file, message: 'Could not reach the backend. Is it running on port 8000?' })
    request.send(data)
  }

  const onDrop = (event) => {
    event.preventDefault()
    setIsDragging(false)
    uploadFile(event.dataTransfer.files[0])
  }

  const askQuestion = async (event) => {
    event.preventDefault()
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || isQuerying) return

    setMessages((current) => [...current, { role: 'user', content: trimmedQuestion }])
    setQuestion('')
    setIsQuerying(true)
    try {
      const response = await fetch(`${API_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmedQuestion }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Unable to answer your question.')
      setMessages((current) => [...current, { role: 'assistant', content: data.answer, sources: data.sources || [] }])
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', content: error.message || 'Something went wrong. Please try again.', error: true }])
    } finally {
      setIsQuerying(false)
    }
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="workspace" aria-label="Document question and answer workspace">
        <header className="page-header">
          <div className="brand-mark">S</div>
          <div>
            <p className="eyebrow">Document intelligence</p>
            <h1>Search what matters.</h1>
            <p className="subtitle">Upload a document, then ask clear, sourced questions about it.</p>
          </div>
        </header>

        <section className="panel upload-panel" aria-labelledby="upload-title">
          <div className="panel-heading">
            <div><p className="section-number">01</p><h2 id="upload-title">Add a document</h2></div>
            <span className="format-label">TXT · MD · PDF</span>
          </div>
          <div
            className={`drop-zone ${isDragging ? 'is-dragging' : ''} ${upload.status === 'success' ? 'is-success' : ''}`}
            role="button"
            tabIndex="0"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click() }}
            onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
          >
            <input ref={inputRef} type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onChange={(event) => uploadFile(event.target.files[0])} />
            <div className="upload-icon"><UploadIcon /></div>
            <div className="drop-copy">
              <strong>{isDragging ? 'Drop it here' : 'Drop your file here'}</strong>
              <span>or <em>browse from your computer</em></span>
            </div>
          </div>
          {upload.status !== 'idle' && (
            <div className={`upload-status ${upload.status}`} role={upload.status === 'error' ? 'alert' : 'status'}>
              <div className="file-summary"><span className="status-symbol">{upload.status === 'success' ? '✓' : upload.status === 'error' ? '!' : '↑'}</span><span className="file-name">{upload.file?.name}</span></div>
              {upload.status === 'uploading' && <div className="progress-wrap"><div className="progress-label"><span>{upload.message}</span><span>{upload.progress}%</span></div><div className="progress-track"><span style={{ width: `${upload.progress}%` }} /></div></div>}
              {upload.status !== 'uploading' && <span className="upload-message">{upload.message}</span>}
            </div>
          )}
        </section>

        <section className="panel chat-panel" aria-labelledby="chat-title">
          <div className="panel-heading"><div><p className="section-number">02</p><h2 id="chat-title">Ask your document</h2></div><span className="ready-dot">Ready when you are</span></div>
          <div className="conversation" aria-live="polite">
            {messages.length === 0 && !isQuerying ? <div className="empty-state"><span className="sparkle">✦</span><p>Ask a question to find answers grounded in your uploaded documents.</p></div> : messages.map((message, index) => (
              <article className={`message ${message.role} ${message.error ? 'has-error' : ''}`} key={index}>
                <span className="avatar">{message.role === 'user' ? 'You' : 'S'}</span>
                <div className="message-content"><p>{message.content}</p>
                  {message.role === 'assistant' && message.sources?.length > 0 && <div className="sources"><h3>Sources</h3><div className="source-list">{message.sources.map((source, sourceIndex) => <span className="source-chip" key={`${source.filename}-${source.chunk_index}-${sourceIndex}`}><b>{source.filename}</b><i>Chunk {source.chunk_index}</i></span>)}</div></div>}
                </div>
              </article>
            ))}
            {isQuerying && <article className="message assistant loading-message"><span className="avatar">S</span><div className="typing-indicator"><i /><i /><i /><span>Searching your documents</span></div></article>}
          </div>
          <form className="question-form" onSubmit={askQuestion}>
            <label className="sr-only" htmlFor="question">Ask a question</label>
            <input id="question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question about your documents…" disabled={isQuerying} />
            <button type="submit" disabled={!question.trim() || isQuerying} aria-label="Send question"><SendIcon /></button>
          </form>
        </section>
      </section>
    </main>
  )
}

export default App
