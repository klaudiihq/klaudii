/**
 * Embedding provider — configurable backend (local ONNX or Gemini API).
 *
 * Both implement: embed(text) → Float32Array
 *
 * Usage:
 *   const embedder = require('./embed');
 *   await embedder.init({ provider: 'local' }); // or 'gemini'
 *   const vec = await embedder.embed("some text");
 */

const fs = require("fs");
const path = require("path");

const { CONFIG_DIR } = require("../../lib/paths");
const CONFIG_PATH = path.join(CONFIG_DIR, "memory-config.json");

let _provider = null;
let _config = null;

function loadConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    _config = {
      embedding: {
        provider: "local",
        model: "all-MiniLM-L6-v2",
        dimensions: 384,
      },
    };
  }
  return _config;
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  _config = config;
}

// --- Local ONNX provider ---

let _ort = null;
let _tokenizer = null;
let _session = null;

async function initLocal(config) {
  const modelDir = path.join(CONFIG_DIR, "models", config.model || "all-MiniLM-L6-v2");

  if (!fs.existsSync(path.join(modelDir, "model.onnx"))) {
    throw new Error(
      `Local embedding model not found at ${modelDir}.\n` +
      `Download it with:\n` +
      `  mkdir -p "${modelDir}"\n` +
      `  # Download from https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2\n` +
      `  # Place model.onnx, tokenizer.json, and config.json in ${modelDir}`
    );
  }

  _ort = require("onnxruntime-node");
  _session = await _ort.InferenceSession.create(path.join(modelDir, "model.onnx"));

  // Load tokenizer
  const tokenizerPath = path.join(modelDir, "tokenizer.json");
  if (fs.existsSync(tokenizerPath)) {
    // Use a simple wordpiece tokenizer fallback
    _tokenizer = JSON.parse(fs.readFileSync(tokenizerPath, "utf8"));
  }

  return {
    dimensions: config.dimensions || 384,
    async embed(text) {
      return localEmbed(text, config.dimensions || 384);
    },
  };
}

async function localEmbed(text, dimensions) {
  // Simple tokenization — split on whitespace/punctuation, map to IDs
  // This is a simplified version; a full implementation would use the HF tokenizer
  const tokens = simpleTokenize(text);
  const inputIds = new BigInt64Array(tokens.map(BigInt));
  const attentionMask = new BigInt64Array(tokens.length).fill(1n);
  const tokenTypeIds = new BigInt64Array(tokens.length).fill(0n);

  const feeds = {
    input_ids: new _ort.Tensor("int64", inputIds, [1, tokens.length]),
    attention_mask: new _ort.Tensor("int64", attentionMask, [1, tokens.length]),
    token_type_ids: new _ort.Tensor("int64", tokenTypeIds, [1, tokens.length]),
  };

  const output = await _session.run(feeds);
  // Mean pooling over token embeddings
  const embeddings = output.last_hidden_state || output.token_embeddings || Object.values(output)[0];
  const data = embeddings.data;
  const result = new Float32Array(dimensions);

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < dimensions; j++) {
      result[j] += data[i * dimensions + j];
    }
  }

  for (let j = 0; j < dimensions; j++) {
    result[j] /= tokens.length;
  }

  // L2 normalize
  let norm = 0;
  for (let j = 0; j < dimensions; j++) norm += result[j] * result[j];
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dimensions; j++) result[j] /= norm;

  return result;
}

function simpleTokenize(text, maxLen = 128) {
  // Very basic tokenizer — real implementation would use the vocab
  const words = text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  // CLS=101, SEP=102, UNK=100
  const ids = [101];
  for (const w of words.slice(0, maxLen - 2)) {
    ids.push(hashToken(w));
  }
  ids.push(102);
  return ids;
}

function hashToken(word) {
  // Deterministic hash to a token ID range (1000-30000)
  // This is a fallback — real tokenizer would map to actual vocab
  let h = 0;
  for (let i = 0; i < word.length; i++) {
    h = ((h << 5) - h + word.charCodeAt(i)) | 0;
  }
  return 1000 + (Math.abs(h) % 29000);
}

// --- Gemini Embedding API provider ---

async function initGemini(config) {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini embedding requires GEMINI_API_KEY env var or apiKey in config");
  }

  const model = config.model || "text-embedding-004";
  const dimensions = config.dimensions || 768;

  return {
    dimensions,
    async embed(text) {
      return geminiEmbed(text, model, apiKey, dimensions);
    },
  };
}

async function geminiEmbed(text, model, apiKey, dimensions) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      outputDimensionality: dimensions,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini embedding failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  return new Float32Array(data.embedding.values);
}

// --- Public API ---

async function init(overrides = {}) {
  const config = { ...loadConfig().embedding, ...overrides };

  if (config.provider === "gemini") {
    _provider = await initGemini(config);
  } else if (config.provider === "local") {
    _provider = await initLocal(config);
  } else if (config.provider === "none") {
    // No embeddings — semantic search disabled
    _provider = {
      dimensions: 0,
      async embed() { return null; },
    };
  } else {
    throw new Error(`Unknown embedding provider: ${config.provider}`);
  }

  return _provider;
}

async function embed(text) {
  if (!_provider) {
    // Auto-init with defaults, falling back to 'none' if local model isn't available
    try {
      await init();
    } catch {
      await init({ provider: "none" });
    }
  }
  return _provider.embed(text);
}

function getDimensions() {
  return _provider ? _provider.dimensions : 0;
}

module.exports = { init, embed, getDimensions, loadConfig, saveConfig };
