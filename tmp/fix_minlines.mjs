import fs from 'node:fs';

const file = 'lib/compression.mjs';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /\/\/ Line count guard \(policy-driven\)\n      const minLines = policy\?\.minLinesToCompress \?\? 30;\n      if \(msg\.content\.split\('\n'\)\.length < minLines\) \{\n        newMessages\.push\(msg\);\n        continue;\n      \}/,
  `// Line count guard (policy-driven) - use lower default for compressToolResults
      const minLines = policy?.minLinesToCompress ?? 1;
      if (msg.content.split('\n').length < minLines) {
        newMessages.push(msg);
        continue;
      }`
);

fs.writeFileSync('lib/compression.mjs', content, 'utf8');
console.log('Fixed minLines default');