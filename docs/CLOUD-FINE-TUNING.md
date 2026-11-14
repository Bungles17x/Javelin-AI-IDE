# Cloud-Based Fine-Tuning Guide

This guide explains how to get your own cloud-based AI model that's already fine-tuned for coding, without running the training pipeline locally.

## Why Cloud Fine-Tuning?

- **No GPU required** - Cloud platforms handle the hardware
- **Already trained models** - Many coding models are pre-fine-tuned
- **Custom fine-tuning** - Upload your data and get a custom model
- **Instant deployment** - Models are immediately available via API
- **Pay-per-use** - Only pay for what you use

## Recommended Cloud Platforms

### 1. **Together AI** ⭐ Recommended
- **Best for**: Pre-fine-tuned coding models + custom fine-tuning
- **Models**: Mixtral 8x7B, Qwen2.5 72B, Llama 3.1 70B
- **Custom Training**: Yes, supports LoRA fine-tuning
- **Pricing**: Competitive, with free tier for testing
- **API Key**: https://api.together.xyz/
- **Setup**: 
  1. Get API key
  2. Select "Together AI" provider in Javelin settings
  3. Choose a coding model (Mixtral 8x7B is excellent for code)

### 2. **Replicate**
- **Best for**: Community fine-tuned models + custom training
- **Models**: CodeLlama 34B, Mistral 7B, Llama 2 70B
- **Custom Training**: Yes, supports various fine-tuning methods
- **Pricing**: Pay-per-second inference
- **API Key**: https://replicate.com/account/api-tokens
- **Setup**:
  1. Get API key
  2. Select "Replicate" provider in Javelin settings
  3. Choose a coding model

### 3. **Anyscale**
- **Best for**: Enterprise-grade fine-tuning
- **Models**: Mistral 7B, Llama 2 70B
- **Custom Training**: Yes, production-grade fine-tuning
- **Pricing**: Enterprise pricing
- **API Key**: https://console.anyscale.com/
- **Setup**:
  1. Get API key
  2. Select "Anyscale" provider in Javelin settings
  3. Choose a model

### 4. **OpenRouter** 
- **Best for**: Access to many models in one place
- **Models**: Claude, GPT-4, Gemini, Llama, etc.
- **Custom Training**: No (access to existing models only)
- **Pricing**: Pay-per-token
- **API Key**: https://openrouter.ai/keys
- **Setup**:
  1. Get API key
  2. Select "OpenRouter" provider in Javelin settings
  3. Choose a model

## Quick Start with Pre-Fine-Tuned Models

The fastest way to get a coding-specialized model is to use a pre-fine-tuned model:

### Option 1: Together AI (Recommended)
```bash
# 1. Get API key from https://api.together.xyz/
# 2. Open Javelin settings (Ctrl+,)
# 3. Select "Together AI" provider
# 4. Paste your API key
# 5. Choose "Mixtral 8x7B" - excellent for coding
```

### Option 2: Replicate
```bash
# 1. Get API key from https://replicate.com/account/api-tokens
# 2. Open Javelin settings (Ctrl+,)
# 3. Select "Replicate" provider
# 4. Paste your API key
# 5. Choose "CodeLlama 34B" - coding-specialized
```

## Custom Fine-Tuning Your Own Model

If you want a model fine-tuned on your specific codebase:

### Step 1: Prepare Your Training Data
```bash
# Capture Javelin runs as training data
npm run train:dataset --traces traces/ --out datasets/my-codebase
```

### Step 2: Upload to Cloud Platform

#### Together AI Custom Training
1. Go to https://api.together.xyz/
2. Navigate to "Fine-tuning"
3. Upload your dataset (JSONL format)
4. Select base model (e.g., Mixtral 8x7B)
5. Start training (typically 1-2 hours)
6. Deploy your fine-tuned model
7. Use the model ID in Javelin settings

#### Replicate Custom Training
1. Go to https://replicate.com/
2. Navigate to "Train"
3. Upload your dataset
4. Select base model
5. Configure training parameters
6. Start training
7. Deploy and use in Javelin

### Step 3: Use Your Custom Model in Javelin
```bash
# In Javelin settings:
# 1. Select the appropriate provider (Together AI, Replicate, etc.)
# 2. Paste your API key
# 3. Enter your custom model ID (e.g., "your-username/your-model-name")
# 4. Save and start coding!
```

## Model Recommendations for Coding

| Model | Platform | Strength | Use Case |
|-------|----------|----------|----------|
| Mixtral 8x7B | Together AI | Excellent code generation | General coding |
| Qwen2.5 72B | Together AI | Strong reasoning | Complex refactoring |
| CodeLlama 34B | Replicate | Code-specialized | Focused coding tasks |
| Mistral 7B | Anyscale | Fast, efficient | Quick edits |
| Claude Sonnet 4 | OpenRouter | Best overall quality | Production code |

## Cost Comparison

**Per 1M tokens (approximate):**
- Together AI: $0.50 - $2.00
- Replicate: $0.50 - $3.00
- Anyscale: $1.00 - $5.00
- OpenRouter: $0.50 - $15.00 (varies by model)

**Custom fine-tuning (one-time):**
- Together AI: $50 - $200
- Replicate: $100 - $500
- Anyscale: $500+ (enterprise)

## Tips for Best Results

1. **Start with pre-fine-tuned models** - They're already optimized for coding
2. **Use Javelin's capture feature** - Generate training data from real coding sessions
3. **Fine-tune on your codebase** - Creates a model that knows your patterns
4. **Test with small datasets first** - Validate before scaling up
5. **Monitor token usage** - Coding tasks can be token-intensive

## Integration with Javelin

All cloud providers integrate seamlessly with Javelin:
- Full tool support (read, write, edit, delete, rename, copy)
- Approval gates for file operations
- Streaming responses
- Error handling
- Autonomy modes

The only difference from local models is that your code is sent to the cloud provider (encrypted and according to their privacy policy).

## Privacy Considerations

- **Together AI**: Does not train on your data by default
- **Replicate**: Does not train on your data without explicit consent
- **Anyscale**: Enterprise-grade privacy controls
- **OpenRouter**: Varies by model, check individual model policies

Always review the privacy policy of your chosen provider.

## Troubleshooting

**Model not available:**
- Check your API key is valid
- Verify the model ID is correct
- Some models may be region-restricted

**Slow responses:**
- Try a smaller model for faster responses
- Check your internet connection
- Consider using a different provider

**Poor code quality:**
- Try a model specifically fine-tuned for coding
- Use Javelin's verification features
- Provide more context in your prompts

## Next Steps

1. **Start with Together AI + Mixtral 8x7B** - Best balance of quality and cost
2. **Capture some coding sessions** - Build your training dataset
3. **Fine-tune on your codebase** - Create your specialized model
4. **Deploy and iterate** - Continuously improve based on results

For more information on the local training pipeline, see [TRAINING.md](TRAINING.md).
