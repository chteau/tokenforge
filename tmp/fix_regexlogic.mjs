import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /const keepRatio = linesToKeep\.size \/ lines\.length;\n  if \(keepRatio > 0\.6 \|\| linesToKeep\.size === 0\) \{\n    return \{ compressedSource: text, originalLines: lines\.length, compressedLines: lines\.length, nodesFound: 0, nodesCompressed: 0, languageDetected: languageHint, syntaxValid: true \};\n  \}\n\n  \/\/ Build compressed output/,
  `const keepRatio = linesToKeep.size / lines.length;
  if (keepRatio > 0.6 || linesToKeep.size === 0) {
    return { compressedSource: text, originalLines: lines.length, compressedLines: lines.length, nodesFound: 0, nodesCompressed: 0, languageDetected: languageHint, syntaxValid: true };
  }
  
  // Skip trivial content (1 line or less) - unless explicitly skipped
  if (!skipTrivialCheck) {
    const lineCount = lines.length;
    if (lineCount <= 1) {
      return { compressedSource: text, originalLines: lines.length, compressedLines: lines.length, nodesFound: 0, nodesCompressed: 0, languageDetected: languageHint, syntaxValid: true };
    }
    
    // Skip content with too few lines
    if (lineCount < COMPRESSION_THRESHOLD_LINES) {
      return { compressedSource: text, originalLines: lines.length, compressedLines: lines.length, nodesFound: 0, nodesCompressed: 0, languageDetected: languageHint, syntaxValid: true };
    }
  }
  
  // Build compressed output`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed regexFallbackCompress skipTrivialCheck logic');