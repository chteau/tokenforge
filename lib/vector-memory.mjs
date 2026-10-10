/**
 * Vector Memory Enhancement
 * 
 * Adds semantic search capability to Token Forge's memory system using
 * TF-IDF + Approximate Nearest Neighbor (ANN) in pure JavaScript.
 * No external dependencies (no ONNX, no HNSW native).
 * 
 * Features:
 * - TF-IDF vectorization of session content
 * - ANN search using random projection trees (RP-trees)
 * - Incremental updates
 * - Per-project isolation
 * - Content-hash based invalidation
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globalCacheRegistry, createFileStore, fileContentHashSync } from './cache-invalidation.mjs';
import { projectRoot } from './util.mjs';
import { cacheBase } from './usage.mjs';

const VECTOR_DIR = 'vector-memory';
const TFIDF_MIN_DF = 2;        // Minimum document frequency
const TFIDF_MAX_DF = 0.8;      // Maximum document frequency (fraction)
const VECTOR_DIM = 256;        // Reduced dimension for ANN
const RP_TREE_COUNT = 4;       // Number of random projection trees
const RP_TREE_DEPTH = 10;      // Depth of each tree
const MAX_SESSIONS_INDEXED = 500;

// Stopwords for TF-IDF
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','to','of','in','on','at','by','with','from','into','onto','as','is','are','was','were','be','been','being',
  'it','its','this','that','these','those','i','you','we','they','he','she','me','my','our','your','their','please','can','could','would','should','will','shall','may','might','must',
  'do','does','did','done','not','no','yes','so','too','very','just','also','only','all','any','some','more','most','such','what','which','who','whom','whose','when','where','why','how',
  'there','here','than','out','up','down','over','under','again','once','about','after','before','between','both','each','few','other','own','same','have','has','had','having','get','got',
  'make','made','use','used','file','files','code','run','add','fix','change','update','new','now','like','want','need','still','one','two','way','thing','things','work','make','sure',
  'lets','let','possibly','perhaps','maybe','probably','actually','really','already','even','know','think','thought','feel','feels','felt','something','anything','everything','nothing',
  'someone','yourself','myself','ourselves','nice','good','great','better','best','bad','worse','alright','okay','yeah','yep','sure','instead','rather','though','although','without',
  'within','while','since','because','around','through','across','along','idea','ideas','useful','possible','needed','reading','isn','aren','doesn','don','didn','won','wouldn','couldn',
  'shouldn','hasn','haven','wasn','weren','every','much','many','well','less','more','lot','lots','bit','kind','sort','able','going','gonna','wanna','gotta','seems','seem','look','looks',
  'looking','explain','explicitely','explicitly','further','heavily','quite','pretty','basically','literally','simply','right','left','first','last','next','previous','another','others',
  'either','neither','whether','done','doing','tried','try','trying','give','gave','take','took','keep','kept','put','says','said','tell','told','ask','asked','show','shows','showed',
  'see','seen','saw','come','came','goes','went','thanks','thank','hello','hey','hi','claude','project','tasks','task','stuff','issue','issues','problem','problems','question','way','ways',
  'time','times','today','yesterday','tomorrow','day','days','using','real',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * TF-IDF Vectorizer with incremental updates
 */
export class TFIDFVectorizer {
  constructor() {
    this.vocabulary = new Map(); // term -> { df, idf, index }
    this.docVectors = new Map(); // docId -> Float32Array
    this.docMetadata = new Map(); // docId -> { sessionId, timestamp, contentHash, terms }
    this.docCount = 0;
    this._dirty = false;
  }

  /**
   * Add or update a document
   */
  addDocument(docId, text, metadata = {}) {
    const terms = tokenize(text);
    const termFreq = new Map();
    for (const term of terms) termFreq.set(term, (termFreq.get(term) || 0) + 1);
    
    // Update document frequency
    for (const term of termFreq.keys()) {
      const entry = this.vocabulary.get(term) || { df: 0, idf: 0, index: -1 };
      entry.df++;
      this.vocabulary.set(term, entry);
    }
    
    // Store document metadata
    this.docMetadata.set(docId, {
      ...metadata,
      terms: termFreq,
      contentHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    });
    
    this._dirty = true;
  }

  /**
   * Remove a document
   */
  removeDocument(docId) {
    const meta = this.docMetadata.get(docId);
    if (!meta) return;
    
    for (const term of meta.terms.keys()) {
      const entry = this.vocabulary.get(term);
      if (entry) {
        entry.df = Math.max(0, entry.df - 1);
        if (entry.df === 0) this.vocabulary.delete(term);
      }
    }
    
    this.docMetadata.delete(docId);
    this.docVectors.delete(docId);
    this._dirty = true;
  }

  /**
   * Rebuild vocabulary and IDF weights
   */
  rebuild() {
    // Filter vocabulary by document frequency
    const validTerms = [];
    for (const [term, entry] of this.vocabulary) {
      const dfRatio = entry.df / Math.max(1, this.docMetadata.size);
      if (entry.df >= TFIDF_MIN_DF && dfRatio <= TFIDF_MAX_DF) {
        validTerms.push(term);
      }
    }
    
    // Assign indices
    validTerms.sort(); // Deterministic ordering
    let index = 0;
    for (const term of validTerms) {
      const entry = this.vocabulary.get(term);
      entry.index = index++;
      entry.idf = Math.log(this.docMetadata.size / (1 + entry.df)) + 1;
    }
    
    // Remove invalid terms
    for (const term of this.vocabulary.keys()) {
      if (!validTerms.includes(term)) this.vocabulary.delete(term);
    }
    
    // Recompute all document vectors
    this.docVectors.clear();
    for (const [docId, meta] of this.docMetadata) {
      this.docVectors.set(docId, this._computeVector(meta.terms));
    }
    
    this._dirty = false;
  }

  /**
   * Compute TF-IDF vector for term frequencies
   */
  _computeVector(termFreq) {
    const vector = new Float32Array(VECTOR_DIM);
    const termWeights = new Map();
    
    // Compute TF-IDF for each term
    for (const [term, tf] of termFreq) {
      const entry = this.vocabulary.get(term);
      if (entry && entry.index >= 0) {
        const tfidf = (1 + Math.log(tf)) * entry.idf;
        termWeights.set(entry.index, tfidf);
      }
    }
    
    // Project to reduced dimension using feature hashing
    for (const [index, weight] of termWeights) {
      const reducedIndex = index % VECTOR_DIM;
      vector[reducedIndex] += weight;
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) vector[i] /= norm;
    
    return vector;
  }

  /**
   * Get vector for document (computes if needed)
   */
  getVector(docId) {
    if (this._dirty) this.rebuild();
    return this.docVectors.get(docId) || null;
  }

  /**
   * Get all document vectors as matrix
   */
  getAllVectors() {
    if (this._dirty) this.rebuild();
    const vectors = [];
    const ids = [];
    for (const [docId, vector] of this.docVectors) {
      vectors.push(vector);
      ids.push(docId);
    }
    return { vectors, ids };
  }

  /**
   * Get vocabulary size
   */
  get vocabularySize() {
    return this.vocabulary.size;
  }

  /**
   * Get document count
   */
  get documentCount() {
    return this.docMetadata.size;
  }
}

/**
 * Random Projection Tree for Approximate Nearest Neighbor
 */
class RPNode {
  constructor(depth = 0, maxDepth = RP_TREE_DEPTH) {
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.left = null;
    this.right = null;
    this.projection = null; // Float32Array
    this.docIds = []; // Leaf nodes store doc IDs
    this.isLeaf = true;
  }
}

/**
 * RP-Tree Forest for ANN search
 */
export class RPForest {
  constructor(dim = VECTOR_DIM, treeCount = RP_TREE_COUNT, maxDepth = RP_TREE_DEPTH) {
    this.dim = dim;
    this.treeCount = treeCount;
    this.maxDepth = maxDepth;
    this.trees = [];
    this._projections = []; // Pre-generated random projections per tree
  }

  /**
   * Build forest from document vectors
   */
  build(vectors, ids) {
    // Generate random projections for each tree
    this._projections = [];
    for (let t = 0; t < this.treeCount; t++) {
      const projections = [];
      for (let d = 0; d < this.maxDepth; d++) {
        const proj = new Float32Array(this.dim);
        for (let i = 0; i < this.dim; i++) {
          // Random unit vector
          proj[i] = (Math.random() - 0.5) * 2;
        }
        // Normalize
        let norm = 0;
        for (let i = 0; i < this.dim; i++) norm += proj[i] * proj[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < this.dim; i++) proj[i] /= norm;
        projections.push(proj);
      }
      this._projections.push(projections);
    }
    
    // Build each tree
    this.trees = [];
    for (let t = 0; t < this.treeCount; t++) {
      const root = new RPNode(0, this.maxDepth);
      this._buildTree(root, t, vectors, ids);
      this.trees.push(root);
    }
  }

  _buildTree(node, treeIndex, vectors, ids) {
    if (node.depth >= this.maxDepth || ids.length <= 10) {
      node.isLeaf = true;
      node.docIds = ids;
      return;
    }
    
    node.isLeaf = false;
    node.projection = this._projections[treeIndex][node.depth];
    
    const leftVectors = [], leftIds = [];
    const rightVectors = [], rightIds = [];
    
    for (let i = 0; i < ids.length; i++) {
      const vec = vectors[ids[i]];
      let dot = 0;
      for (let d = 0; d < this.dim; d++) dot += vec[d] * node.projection[d];
      
      if (dot >= 0) {
        leftVectors.push(vec);
        leftIds.push(ids[i]);
      } else {
        rightVectors.push(vec);
        rightIds.push(ids[i]);
      }
    }
    
    if (leftIds.length > 0) {
      node.left = new RPNode(node.depth + 1, this.maxDepth);
      this._buildTree(node.left, treeIndex, leftVectors, leftIds);
    }
    if (rightIds.length > 0) {
      node.right = new RPNode(node.depth + 1, this.maxDepth);
      this._buildTree(node.right, treeIndex, rightVectors, rightIds);
    }
  }

  /**
   * Search for nearest neighbors
   * @param {Float32Array} queryVec - Query vector
   * @param {number} k - Number of results
   * @returns {Array<{docId, score}>}
   */
  search(queryVec, k = 10) {
    const candidates = new Map(); // docId -> { score, count }
    
    // Search each tree
    for (let t = 0; t < this.treeCount; t++) {
      this._searchTree(this.trees[t], queryVec, candidates);
    }
    
    // Sort by score (average across trees)
    const results = Array.from(candidates.entries())
      .map(([docId, data]) => ({ docId, score: data.score / data.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    
    return results;
  }

  _searchTree(node, queryVec, candidates) {
    if (!node) return;
    
    if (node.isLeaf) {
      for (const docId of node.docIds) {
        const entry = candidates.get(docId) || { score: 0, count: 0 };
        // Will compute actual cosine similarity later
        entry.score += 1; // Placeholder
        entry.count += 1;
        candidates.set(docId, entry);
      }
      return;
    }
    
    // Traverse both branches for better recall
    let dot = 0;
    for (let d = 0; d < this.dim; d++) dot += queryVec[d] * node.projection[d];
    
    if (dot >= 0) {
      this._searchTree(node.left, queryVec, candidates);
      this._searchTree(node.right, queryVec, candidates); // Also search other side
    } else {
      this._searchTree(node.right, queryVec, candidates);
      this._searchTree(node.left, queryVec, candidates);
    }
  }
}

/**
 * Vector Memory Manager - ties TF-IDF + ANN together
 */
export class VectorMemory {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.vectorizer = new TFIDFVectorizer();
    this.forest = new RPForest();
    this.initialized = false;
    this.dataFile = path.join(cacheBase(), VECTOR_DIR, `${projectRoot.replace(/[^a-zA-Z0-9]/g, '-')}.json`);
  }

  /**
   * Initialize from existing memory index
   */
  async initialize(memoryIndex) {
    if (this.initialized) return;
    
    // Try to load persisted state
    await this.load();
    
    // Add sessions from memory index
    for (const session of memoryIndex.sessions) {
      const docId = `session:${session.id}`;
      const text = [
        ...session.prompts,
        ...session.commits,
        ...session.edited,
        session.reply || '',
      ].join(' ');
      
      this.vectorizer.addDocument(docId, text, {
        sessionId: session.id,
        timestamp: session.start || Date.now(),
        type: 'session',
        editedFiles: session.edited || [],
        readFiles: session.read || [],
      });
    }
    
    // Rebuild and build forest
    this.vectorizer.rebuild();
    const { vectors, ids } = this.vectorizer.getAllVectors();
    this.forest.build(vectors, ids);
    
    this.initialized = true;
    await this.save();
  }

  /**
   * Search semantically similar sessions
   */
  search(query, k = 5) {
    if (!this.initialized) return [];
    
    // Vectorize query
    const queryTerms = tokenize(query);
    const termFreq = new Map();
    for (const term of queryTerms) termFreq.set(term, (termFreq.get(term) || 0) + 1);
    
    const queryVec = this.vectorizer._computeVector(termFreq);
    
    // ANN search
    const results = this.forest.search(queryVec, k * 2); // Get more candidates
    
    // Re-rank with exact cosine similarity
    const reranked = results.map(r => {
      const vec = this.vectorizer.getVector(r.docId);
      const score = vec ? cosineSimilarity(queryVec, vec) : 0;
      return { ...r, score };
    }).sort((a, b) => b.score - a.score).slice(0, k);
    
    return reranked.map(r => {
      const meta = this.vectorizer.docMetadata.get(r.docId);
      return {
        sessionId: meta?.sessionId,
        score: r.score,
        timestamp: meta?.timestamp,
        preview: meta?.terms ? Array.from(meta.terms.keys()).slice(0, 10).join(', ') : '',
      };
    });
  }

  /**
   * Add new session incrementally
   */
  async addSession(session) {
    const docId = `session:${session.id}`;
    const text = [
      ...session.prompts,
      ...session.commits,
      ...session.edited,
      session.reply || '',
    ].join(' ');
    
    this.vectorizer.addDocument(docId, text, {
      sessionId: session.id,
      timestamp: session.start || Date.now(),
      type: 'session',
      editedFiles: session.edited || [],
      readFiles: session.read || [],
    });
    
    // Rebuild periodically (every 10 sessions)
    if (this.vectorizer.documentCount % 10 === 0) {
      this.vectorizer.rebuild();
      const { vectors, ids } = this.vectorizer.getAllVectors();
      this.forest.build(vectors, ids);
      await this.save();
    }
  }

  /**
   * Invalidate sessions referencing a file
   */
  invalidateFile(filePath) {
    let removed = 0;
    for (const [docId, meta] of this.vectorizer.docMetadata) {
      if (meta.editedFiles?.includes(filePath) || meta.readFiles?.includes(filePath)) {
        this.vectorizer.removeDocument(docId);
        removed++;
      }
    }
    if (removed > 0) {
      this.vectorizer.rebuild();
      const { vectors, ids } = this.vectorizer.getAllVectors();
      this.forest.build(vectors, ids);
      this.save();
    }
    return removed;
  }

  /**
   * Persist to disk
   */
  async save() {
    try {
      await fs.promises.mkdir(path.dirname(this.dataFile), { recursive: true });
      const state = {
        vocabulary: Object.fromEntries(this.vectorizer.vocabulary),
        docMetadata: Object.fromEntries(this.vectorizer.docMetadata),
        docVectors: Object.fromEntries(
          Array.from(this.vectorizer.docVectors.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
        dim: VECTOR_DIM,
        treeCount: RP_TREE_COUNT,
        maxDepth: RP_TREE_DEPTH,
      };
      await fs.promises.writeFile(this.dataFile, JSON.stringify(state));
    } catch (err) {
      console.warn('[VectorMemory] Save failed:', err.message);
    }
  }

  /**
   * Load from disk
   */
  async load() {
    try {
      const state = JSON.parse(await fs.promises.readFile(this.dataFile, 'utf8'));
      this.vectorizer.vocabulary = new Map(Object.entries(state.vocabulary));
      this.vectorizer.docMetadata = new Map(Object.entries(state.docMetadata));
      this.vectorizer.docVectors = new Map(
        Object.entries(state.docVectors).map(([k, v]) => [k, new Float32Array(v)])
      );
      this.vectorizer.docCount = this.vectorizer.docMetadata.size;
      this.vectorizer._dirty = false;
      
      // Rebuild forest
      const { vectors, ids } = this.vectorizer.getAllVectors();
      this.forest.build(vectors, ids);
      
      this.initialized = true;
    } catch {
      // No saved state, will initialize fresh
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      initialized: this.initialized,
      sessionsIndexed: this.vectorizer.documentCount,
      vocabularySize: this.vectorizer.vocabularySize,
      vectorDim: VECTOR_DIM,
      treeCount: RP_TREE_COUNT,
      dataFile: this.dataFile,
    };
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Global vector memory instances per project
 */
const vectorMemories = new Map();

export function getVectorMemory(cwd) {
  const root = projectRoot(cwd);
  if (!vectorMemories.has(root)) {
    vectorMemories.set(root, new VectorMemory(root));
  }
  return vectorMemories.get(root);
}

export async function initializeVectorMemory(cwd, memoryIndex) {
  const vm = getVectorMemory(cwd);
  await vm.initialize(memoryIndex);
  return vm;
}

export async function searchVectorMemory(cwd, query, k = 5) {
  const vm = getVectorMemory(cwd);
  return vm.search(query, k);
}

export async function addSessionToVectorMemory(cwd, session) {
  const vm = getVectorMemory(cwd);
  await vm.addSession(session);
}

export function invalidateVectorMemoryFile(cwd, filePath) {
  const vm = getVectorMemory(cwd);
  return vm.invalidateFile(filePath);
}

export function getVectorMemoryStats(cwd) {
  const vm = getVectorMemory(cwd);
  return vm.getStats();
}

/**
 * Register with formal cache invalidation
 */
export function registerVectorMemoryCache() {
  globalCacheRegistry.register('vector-memory', {
    store: createMapStore(),
    keyFn: (cwd) => projectRoot(cwd),
    depsFn: () => [], // Invalidated via explicit invalidateFile
    invalidateFn: () => 0,
    maxSize: 10,
  });
}