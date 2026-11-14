import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ErrorBoundary } from './components/ErrorScreen.jsx'
import './index.css'
import './liquid-glass.css'
import './system-screens.css'

/*
 * Voice diagnostics without a microphone: `await javelinSpeechProbe(2)` in the
 * console loads the local Whisper model and transcribes N seconds of silence. Useful
 * because microphone access is the one part of the pipeline that cannot be scripted.
 */
window.javelinSpeechProbe = async (seconds = 1) => {
  const { getTranscriber, transcriptionOptions } = await import('./lib/localSpeech.js')
  const loadStart = Date.now()
  const transcribe = await getTranscriber()
  const loadMs = Date.now() - loadStart
  const inferStart = Date.now()
  // Same options the microphone path uses — a diagnostic that skips them hides
  // exactly the class of bug it exists to catch.
  const result = await transcribe(new Float32Array(16000 * seconds), transcriptionOptions())
  return { text: result?.text ?? '', loadMs, inferMs: Date.now() - inferStart }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
