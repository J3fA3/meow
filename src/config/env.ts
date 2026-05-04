import "dotenv/config";

export const config = {
  // LLM
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.LLM_BASE_URL || "https://api.anthropic.com",
  model: process.env.MEOW_MODEL || "claude-3-5-sonnet-latest",

  // Embedding: HuggingFace Inference (primary — free, reliable)
  hfToken: process.env.HF_INFERENCE_TOKEN || "",
  hfEmbedModel: process.env.HF_EMBED_MODEL || "BAAI/bge-base-en-v1.5",

  // Embedding: Ollama (local fallback)
  embedUrl: process.env.OLLAMA_EMBED_URL || "http://localhost:11434/api/embeddings",
  embedModel: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",

  // Embedding: OpenAI (cloud last-resort)
  openAiEmbedKey: process.env.OPENAI_EMBED_KEY || "",

  // Dimension for validation + truncation
  embeddingDimension: 768,
};