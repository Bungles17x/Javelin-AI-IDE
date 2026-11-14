# Javelin AI — Status

## Usable local setup

- The React/Electron app and VS Code extension run the Agent/Javelin tool loops in this repository.
- The default inference target is Javelin Coder served by local Ollama at `http://127.0.0.1:11434/v1`.
- The desktop app can start Ollama and discover installed models. Model weights are installed separately.
- Chat, Agent, and Javelin requests must stay on the local Ollama endpoint; remote AI endpoints are not supported by the desktop/web provider.
- File edits and commands still depend on the selected workspace and user approval/autonomy settings.

## Model reality

The bundled `local-model/` JavaScript transformer and training code are experimental. The sample training data and simplified training implementation do not produce a useful coding model. They are not the active default inference path and should not be described as a trained production model.

Javelin Coder is a local model served by Ollama. The app code in this repository provides the IDE, orchestration, tools, memory, and local integration; it does not train a capable language model from random initialization. Building a competitive base model from scratch requires large-scale data and GPU resources.

## Build and run

```powershell
npm install
.\install.ps1
npm run dev
```

For the desktop app:

```powershell
npm run desktop:dev
```

Build the desktop installer with `npm run desktop:build`. Install and start Ollama separately, and ensure the Javelin model supplied with your distribution appears in `ollama list`.

## Verification

```powershell
npm test
Set-Location vscode-extension
npm run compile
```

Tests and compile results describe the current checkout; they do not prove model quality. Always verify generated code and run the project's own checks before shipping.
