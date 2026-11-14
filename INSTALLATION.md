# Javelin AI Installation Guide

This guide covers installing Javelin as a local coding assistant. Inference uses Ollama on this computer; Javelin does not require or send data to hosted AI APIs.

## System Requirements

### Minimum Requirements
- **OS**: Windows 10+, macOS 10.15+, or Linux
- **Node.js**: v18 or higher
- **npm**: v9 or higher
- **RAM**: 8GB minimum; more memory supports larger local models
- **Disk**: Space for the app and the selected local model (several GB)

### AI Runtime
- [Ollama](https://ollama.com/) installed and running locally
- Javelin Coder installed in Ollama (`ollama list` should show `javelin-coder:latest`)

## Quick Start (Windows)

1. **Download and extract** the Javelin AI ZIP archive
2. **Run the installer**:
   ```cmd
   install.bat
   ```
3. **Confirm the local model is installed**:
   ```powershell
   ollama list
   ```
   If your Javelin distribution did not include `javelin-coder`, install the model using the instructions supplied with that distribution.
4. **Start Javelin**:
   ```cmd
   npm run dev
   ```

## Manual Installation

### Step 1: Install Node.js

Download and install Node.js v18 or higher from https://nodejs.org/

Verify installation:
```bash
node --version
npm --version
```

### Step 2: Install Dependencies

Navigate to the Javelin AI directory and run:

```bash
npm install
```

### Step 3: Install Ollama and the Javelin model

Install Ollama, start it, and verify that `ollama list` contains `javelin-coder:latest`. Model weights are separate from the source checkout. The sample JavaScript training pipeline is experimental and does not produce a useful coding model.

### Step 4: Start Javelin

```bash
npm run dev
```

The web interface will be available at http://localhost:3000

## Installation Modes

### Web Application (Default)
The web app connects only to local Ollama on port 11434.

```bash
npm run dev
```

### Desktop IDE (Windows)
Javelin includes a standalone desktop IDE with integrated code editor and project explorer.

```bash
npm run desktop:dev
```

To build the desktop installer:
```bash
npm run desktop:build
```

### VS Code Extension
Javelin can be installed as a VS Code extension for integration with your existing editor.

```bash
npm run install:extension
```

## Troubleshooting

### Node.js Not Found
**Error**: `'node' is not recognized as an internal or external command`

**Solution**: Install Node.js from https://nodejs.org/ and ensure it's added to your PATH.

### npm Install Fails
**Error**: `npm ERR! code EACCES` or permission errors

**Solution**:
- On Windows: Run Command Prompt as Administrator
- On Linux/macOS: Use `sudo npm install` (not recommended) or fix npm permissions

### Port Already in Use
**Error**: `Port 3000 is already in use`

**Solution**: Either stop the process using port 3000 or specify a different port:
```bash
npm run dev -- --port 3001
```

### Ollama or model not found
If Javelin cannot reach Ollama, start the Ollama application or run `ollama serve`. If the selected model is missing, verify its exact name with `ollama list` and install the model supplied with your Javelin distribution. Javelin only sends inference requests to the local Ollama endpoint.

## Verification

To verify your installation:

1. **Check Node.js and npm**:
   ```bash
   node --version
   npm --version
   ```

2. **Check dependencies**:
   ```bash
   npm list
   ```

3. **Check model status**:
   ```bash
   npm run local:model:info
   ```

4. **Start the dev server**:
   ```bash
   npm run dev
   ```

5. Open http://localhost:3000 in your browser

## Uninstallation

To completely remove Javelin AI:

1. Stop any running Javelin processes
2. Delete the Javelin AI directory
3. Delete the models directory (if separate)
4. Remove any desktop shortcuts or VS Code extensions

## Updates

To update Javelin AI:

1. Make a note of your local Ollama models (`ollama list`; weights are managed outside this repository)
2. Download the new version
3. Extract over the existing installation (or to a new directory)
4. Run `npm install` to update dependencies
5. Restore your models to the `models/` directory

## Next Steps

- [Read the main README](README.md) for an overview
- [Learn about the local model system](local-model/README.md)
- [Experimental JavaScript model notes](local-model/README.md)
- [Explore Javelin Core architecture](docs/JAVELIN-CORE.md)
