import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /function regexFallbackCompress\(text, languageHint, maxBodyLines, preserveErrorHandlers\) \{/,
  `function regexFallbackCompress(text, languageHint, maxBodyLines, preserveErrorHandlers, skipTrivialCheck = false) {`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed regexFallbackCompress signature');