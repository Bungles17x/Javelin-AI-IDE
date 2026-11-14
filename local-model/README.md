# Experimental JavaScript Model

This directory contains a small, experimental transformer implementation and training prototype. It is not the default model used by the Javelin IDE and it does not provide production-quality coding assistance.

The checked-in sample dataset is only a smoke-test fixture. The current model/training setup is too small and simplified to learn useful coding behavior; running it does not create a competitive assistant. Do not treat successful training completion or a saved model file as evidence of model quality.

## Active local inference

The IDE uses Javelin Coder through Ollama on the same machine:

```text
http://127.0.0.1:11434/v1
```

Install/start Ollama and verify the model supplied with your Javelin distribution appears in:

```powershell
ollama list
```

See the root [README](../README.md) and [installation guide](../INSTALLATION.md) for running Javelin. Prompts and project context are sent only to that local Ollama endpoint.

## Building a useful model from random weights

The code here is not a shortcut to a capable coding model. That requires a real tokenizer and training implementation, a legally usable large corpus, substantial GPU compute, and systematic evaluation. None of those requirements are satisfied by the sample files in this directory.
