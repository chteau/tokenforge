import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /const preserveErrorHandlers = policy\.preserveErrorHandlers \?\? true;\n  const minTokensToCompress = policy\.minTokensToCompress \?\? 80;\n\n  \/\/ Skip small content\n  if \(typeof text !== 'string' \|\| text\.length < minTokensToCompress \* 4\) \{\n    return \{ kept: text, vaulted: false, reason: 'below_threshold' \};\n  \}\n\n  \/\/ Skip content with too few lines\n  const lineCount = text\.split\('\n'\)\.length;\n  if \(lineCount < COMPRESSION_THRESHOLD_LINES\) \{\n    return \{ kept: text, vaulted: false, reason: 'too_few_lines' \};\n  \}/,
  `const preserveErrorHandlers = policy.preserveErrorHandlers ?? true;
  const minTokensToCompress = policy.minTokensToCompress ?? 80;
  
  // Skip trivial content (1 line or less)
  const lineCount = text.split('\n').length;
  if (lineCount <= 1) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }
  
  // Skip content with too few lines
  if (lineCount < COMPRESSION_THRESHOLD_LINES) {
    return { kept: text, vaulted: false, reason: 'too_few_lines' };
  }
  
  // Skip small content
  if (typeof text !== 'string' || text.length < minTokensToCompress * 4) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed compressCode logic');