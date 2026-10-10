import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /export async function compressCode\(text, languageHint = '', policy = {}, filePath = null\) \{\n  const mode = policy\.mode \|\| 'balanced';\n  const maxBodyLines = policy\.maxBodyLines \?\? \(mode === 'aggressive' \? 2 : mode === 'minimal' \? 8 : 4\);\n  const preserveErrorHandlers = policy\.preserveErrorHandlers \?\? true;\n  const minTokensToCompress = policy\.minTokensToCompress \?\? 80;\n  \n  \/\/ Skip trivial content \(1 line or less\)\n  const lineCount = text\.split\('\n'\)\.length;\n  if \(lineCount <= 1\) \{\n    return \{ kept: text, vaulted: false, reason: 'below_threshold' \};\n  \}\n  \n  \/\/ Skip content with too few lines\n  if \(lineCount < COMPRESSION_THRESHOLD_LINES\) \{\n    return \{ kept: text, vaulted: false, reason: 'too_few_lines' \};\n  \}\n  \n  \/\/ Skip small content\n  if \(typeof text !== 'string' \|\| text\.length < minTokensToCompress \* 4\) \{\n    return \{ kept: text, vaulted: false, reason: 'below_threshold' \};\n  \}/,
  `export async function compressCode(text, languageHint = '', policy = {}, filePath = null) {
  const mode = policy.mode || 'balanced';
  const maxBodyLines = policy.maxBodyLines ?? (mode === 'aggressive' ? 2 : mode === 'minimal' ? 8 : 4);
  const preserveErrorHandlers = policy.preserveErrorHandlers ?? true;
  const minTokensToCompress = policy.minTokensToCompress ?? 80;
  const skipTrivialCheck = policy.skipTrivialCheck ?? false;
  
  // Skip trivial content (1 line or less) - unless explicitly skipped
  if (!skipTrivialCheck) {
    const lineCount = text.split('\n').length;
    if (lineCount <= 1) {
      return { kept: text, vaulted: false, reason: 'below_threshold' };
    }
    
    // Skip content with too few lines
    if (lineCount < COMPRESSION_THRESHOLD_LINES) {
      return { kept: text, vaulted: false, reason: 'too_few_lines' };
    }
  }
  
  // Skip small content
  if (typeof text !== 'string' || text.length < minTokensToCompress * 4) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed compressCode skipTrivialCheck');