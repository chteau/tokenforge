import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /const result = await compressCode\(msg\.content, langHint, policy, msg\._filename\);/,
  `const result = await compressCode(msg.content, langHint, { ...policy, skipTrivialCheck: true }, msg._filename);`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed compressToolResults skipTrivialCheck');