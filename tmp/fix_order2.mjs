import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /\/\/ Skip content with too few lines\n  const lineCount = text\.split\('\n'\)\.length;\n  if \(lineCount < COMPRESSION_THRESHOLD_LINES\) \{\n    return \{ kept: text, vaulted: false, reason: 'too_few_lines' \};\n  \}\n\n  \/\/ Skip small content\n  if \(typeof text !== 'string' \|\| text\.length < minTokensToCompress \* 4\) \{\n    return \{ kept: text, vaulted: false, reason: 'below_threshold' \};\n  \}/,
  `// Skip small content
  if (typeof text !== 'string' || text.length < minTokensToCompress * 4) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }
  
  // Skip content with too few lines
  const lineCount = text.split('\n').length;
  if (lineCount < COMPRESSION_THRESHOLD_LINES) {
    return { kept: text, vaulted: false, reason: 'too_few_lines' };
  }`
);

fs.writeFileSync('lib/compression.mjs', content);
console.log('Fixed order');