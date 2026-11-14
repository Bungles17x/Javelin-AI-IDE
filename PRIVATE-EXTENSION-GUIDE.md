# Javelin AI - Private Extension Setup Guide

## 🔒 Authorization & Security

**This extension is PRIVATE and licensed exclusively to:**
- **User**: lildc (Bungles17x)

### ⚠️ Current Status: Authorization Temporarily Disabled

**For testing purposes, the authorization check is currently disabled.** The extension will work for any user right now.

### How to Re-Enable Authorization

When you're ready to enforce security, edit `vscode-extension/src/extension.ts`:

1. Find the `isUserAuthorized()` function (around line 10)
2. Replace the temporary return with the original logic
3. Uncomment the authorization code block
4. Recompile: `cd vscode-extension && npm run compile`

The authorization logic checks:
1. **Username Check**: Verifies the current Windows username is either `lildc` or `bungles17x`
2. **Environment Variable**: Checks `USERNAME` or `USER` environment variables first (faster)
3. **System Info**: Falls back to `os.userInfo()` if env vars fail

### Bypass for Development

To bypass authorization for development (when re-enabled):
```powershell
set JAVELIN_ALLOW_ALL=true
```

### What Happens If Unauthorized (When Re-Enabled)

If someone tries to install/use this extension without authorization:
- The extension will not activate
- A clear error message displays: "🔒 Unauthorized: Javelin AI Assistant is a private extension licensed exclusively to lildc (Bungles17x)"
- The extension remains disabled

---

## 🚀 Installation

### For the Web App (Browser)

1. **Build the web app**:
   ```bash
   cd "C:\Users\lildc\Desktop\Javelin AI"
   npm run build
   ```

2. **Serve the built files**:
   ```bash
   npx serve dist
   ```
   Or use any static file server (Vercel, Netlify, etc.)

3. **Open in browser**: Navigate to `http://localhost:3000`

### For VS Code Extension

1. **Build the extension**:
   ```bash
   cd "C:\Users\lildc\Desktop\Javelin AI\vscode-extension"
   npm run compile
   ```

2. **Package the extension** (optional, for sharing):
   ```bash
   npm install -g vsce
   vsce package
   ```

3. **Install in VS Code**:
   - Press `Ctrl+Shift+P`
   - Type "Install from VSIX"
   - Select the generated `.vsix` file
   - OR: Open the extension folder directly in VS Code and press F5 to debug

### Automatic Updates for the Private Extension

The VS Code Marketplace does not provide private listings for this extension, so updates are distributed through private GitHub Releases. Install the VSIX once, then:

1. Create a GitHub fine-grained personal access token limited to `Bungles17x/Javelin-AI` with **Contents: Read-only** permission.
2. In VS Code, run **Javelin AI: Configure Private Update Access** and enter the token. VS Code stores it in encrypted SecretStorage, not in settings or workspace files.
3. Publish a release by increasing the extension version and pushing a matching version tag. From PowerShell:

   ```powershell
   npm version patch --prefix vscode-extension --no-git-tag-version
   $version = node -p "require('./vscode-extension/package.json').version"
   git add vscode-extension/package.json vscode-extension/package-lock.json
   git commit -m "Release VS Code extension v$version"
   git tag "v$version"
   git push origin HEAD
   git push origin "v$version"
   ```

   The GitHub Actions workflow builds the VSIX and attaches it to that private release. The tag must match the version in `vscode-extension/package.json`.
4. The extension checks for updates at startup (at most every 12 hours), installs a newer release automatically, and asks to reload VS Code to activate it.

Use **Javelin AI: Check for Updates** to check immediately. If update access needs to be changed, run **Javelin AI: Configure Private Update Access** again; leaving the token blank clears it.

---

## 🌐 Cloud Providers for Your Own AI Model

### Quick Start (No Training Required)

**Together AI (Recommended)** - Best balance of quality and cost:
1. Get API key: https://api.together.xyz/
2. In VS Code settings, select "Together AI" provider
3. Choose "Mixtral 8x7B (Coding)" - excellent for code
4. Start coding immediately!

**Replicate** - Community fine-tuned models:
1. Get API key: https://replicate.com/account/api-tokens
2. Select "Replicate" provider
3. Choose "CodeLlama 34B" - coding-specialized

### All Supported Cloud Providers

| Provider | Models | Best For | Cost | API Key |
|----------|--------|----------|------|---------|
| **Together AI** | Mixtral 8x7B, Qwen2.5 Coder 32B, DeepSeek Coder V2 | General coding | $0.50-$2/1M tokens | https://api.together.xyz/ |
| **Replicate** | CodeLlama 34B, Arctic Instruct | Coding tasks | $0.50-$3/1M tokens | https://replicate.com/ |
| **OpenAI** | GPT-4o, GPT-4o Mini, GPT-4 Turbo | Production code | $5-$30/1M tokens | https://platform.openai.com/ |
| **Anthropic** | Claude Sonnet 4, Claude 3.5 Sonnet | Best overall quality | $3-$15/1M tokens | https://console.anthropic.com/ |
| **Anyscale** | Mistral 7B, Llama 3.1 8B | Enterprise | $1-$5/1M tokens | https://console.anyscale.com/ |
| **OpenRouter** | Claude, GPT-4, Gemini, Llama | Many models | $0.50-$15/1M tokens | https://openrouter.ai/ |
| **Groq** | Llama 3.3 70B, GPT-OSS 120B | Fast inference | Free tier available | https://console.groq.com/ |

### Custom Fine-Tuning Your Own Model

Want a model fine-tuned on YOUR codebase?

1. **Capture Javelin runs**:
   ```bash
   npm run train:dataset --traces traces/ --out datasets/my-codebase
   ```

2. **Upload to cloud platform**:
   - Together AI: Navigate to fine-tuning section, upload dataset
   - Replicate: Use the train feature with your dataset
   - Select base model (e.g., Mixtral 8x7B)
   - Start training (1-2 hours)

3. **Use your custom model**:
   - In VS Code settings, select the provider
   - Enter your custom model ID (e.g., `your-username/your-model-name`)
   - Start coding with your personalized model!

For detailed guide, see `docs/CLOUD-FINE-TUNING.md`

---

## 🛠️ Features

### File Operations (Works in Both Web & VS Code)

- ✅ **List files** - See project structure
- ✅ **Read files** - Read entire files or line ranges
- ✅ **Search code** - Search for text or regex patterns
- ✅ **Write files** - Create new files (won't overwrite without permission)
- ✅ **Edit files** - Exact snippet replacement (safe default)
- ✅ **Delete files** - Delete with approval (gated for safety)
- ✅ **Rename files** - Move/rename files with approval
- ✅ **Copy files** - Duplicate files within workspace

### Safety Features

- **Approval gates** - All file changes require approval (configurable)
- **Checkpoints** - Automatic snapshots before changes
- **Revert** - Restore to any checkpoint
- **Command blocking** - Dangerous commands blocked (rm -rf /, format, etc.)
- **Safe commands** - Test/build/lint commands auto-approved
- **No blind overwrites** - Never replaces files without explicit permission

### Autonomy Modes

1. **Ask (default)** - Prompt before every change
2. **Auto-edit** - Apply edits automatically, but still ask for deletions
3. **Full** - Complete autonomy (use with caution)

### Keyboard Shortcuts (Web App)

- `Ctrl/Cmd + K` - Focus input field
- `Ctrl/Cmd + L` - Clear conversation
- `Ctrl/Cmd + ,` - Open settings
- `Escape` - Stop operations or close dialogs

---

## 🧪 Testing

All tests pass successfully:
```bash
npm test
```

Test coverage includes:
- Agent loop and safety
- File permissions and approvals
- Training pipeline
- Model registry
- Webview integrity
- Workspace visibility

---

## 📝 Configuration

### VS Code Settings

```json
{
  "javelin.provider": "together",
  "javelin.baseUrl": "",
  "javelin.model": "mistralai/Mixtral-8x7B-Instruct-v0.1",
  "javelin.groqApiKey": "",
  "javelin.autonomy": "ask",
  "javelin.agentAutoApproveSafeCommands": true,
  "javelin.agentMaxSteps": 24,
  "javelin.agentLiveEditInEditor": true,
  "javelin.agentAnimateEdits": true,
  "javelin.agentEditSpeedMs": 24
}
```

### Web App Settings

Settings are stored in browser localStorage and include:
- Provider selection
- API keys (encrypted)
- Model selection
- Autonomy mode
- Theme (dark/light)

---

## 🔧 Troubleshooting

### "Unauthorized" Error

**Problem**: Extension won't activate
**Solution**: 
- Verify your username is `lildc` or `bungles17x`
- Verify your hostname includes `lildc-pc`
- For development, set `JAVELIN_ALLOW_ALL=true`

### "Could not reach local model"

**Problem**: Local provider can't connect
**Solution**:
- Ensure Ollama is running: `ollama serve`
- Check the base URL in settings
- Try a cloud provider instead

### "Invalid API key"

**Problem**: Cloud provider rejects API key
**Solution**:
- Verify the key is correct
- Check the key hasn't expired
- Use the "Set API Key" command to update it

### Extension Won't Load

**Problem**: VS Code extension fails to activate
**Solution**:
- Check the VS Code output panel for errors
- Ensure you're authorized (see above)
- Try recompiling: `cd vscode-extension && npm run compile`

---

## 📚 Documentation

- **Cloud Fine-Tuning**: `docs/CLOUD-FINE-TUNING.md`
- **Local Training**: `docs/TRAINING.md`
- **Main README**: `README.md`

---

## ✅ What Was Enhanced

### 1. New File Operations
- `rename_file` - Move/rename files
- `copy_file` - Duplicate files
- Full error handling and validation

### 2. Expanded Cloud Providers
- Together AI (pre-fine-tuned coding models)
- Replicate (community models)
- OpenAI (GPT models)
- Anthropic Claude
- Anyscale (enterprise)
- OpenRouter (multi-model)

### 3. Enhanced Security
- 47 blocked command patterns (was 10)
- 42 safe command patterns (was 13)
- Dual-layer authorization (user + machine)

### 4. Performance
- File size limits (2MB per file, 50MB total)
- Simple diff for large files
- Search limits (max 100 files)

### 5. User Experience
- Keyboard shortcuts
- Better error messages
- Provider-specific help text
- Cloud fine-tuning guide

### 6. VS Code Extension
- Full parity with web app features
- Authorization guard
- All new file operations
- All cloud providers
- Enhanced command blocking

---

## 🎯 Recommended Setup

### For Daily Use (Fast & Free)

1. **Use Together AI with Mixtral 8x7B**
   - Best balance of quality and cost
   - Excellent for coding
   - ~$0.50/1M tokens

2. **Set autonomy to "auto-edit"**
   - Edits apply automatically
   - Still asks for deletions
   - Faster workflow

3. **Enable safe command auto-approval**
   - Tests run without prompts
   - Only unusual commands ask for approval

### For Custom Model (Your Own Fine-Tune)

1. **Capture your coding sessions**
2. **Upload to Together AI**
3. **Fine-tune on your codebase**
4. **Use your personalized model**

See `docs/CLOUD-FINE-TUNING.md` for details.

---

## 📞 Support

For issues specific to this private extension:
- Check the authorization system first
- Review the troubleshooting section
- Ensure both web app and VS Code extension build successfully

---

**Version**: 1.2.0
**Last Updated**: 2026-10-01
**Licensed To**: lildc (Bungles17x) - Private Use Only
