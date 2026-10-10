import './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findOnPath, spawnable } from '../lib/util.mjs';

const winEnv = (dir) => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', comspec: 'C:\\Windows\\system32\\cmd.exe' });

test('findOnPath tries PATHEXT on Windows and ignores extensionless files there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-'));
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n'); // npm also writes an sh script next to the .cmd
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
  assert.equal(findOnPath('claude', { platform: 'win32', env: winEnv(dir) }), path.join(dir, 'claude.cmd'));
  assert.equal(findOnPath('claude', { platform: 'linux', env: { PATH: dir } }), path.join(dir, 'claude'));
  assert.equal(findOnPath('nope', { platform: 'win32', env: winEnv(dir) }), null);
  fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  assert.equal(findOnPath('claude', { platform: 'win32', env: winEnv(dir) }), path.join(dir, 'claude.exe'));
});

test('spawnable runs a Windows .cmd through cmd.exe with every argument escaped, and leaves .exe and POSIX alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  const args = ['-p', 'say "hi" & exit', '--x=C:\\a b\\'];
  const sp = spawnable('claude', args, { platform: 'win32', env: winEnv(dir) });
  assert.equal(sp.cmd, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(sp.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(sp.args[3], `"${path.join(dir, 'claude.cmd')} ^"-p^" ^"say^ \\^"hi\\^"^ ^&^ exit^" ^"--x=C:\\a^ b\\\\^""`);
  assert.equal(sp.opts.windowsVerbatimArguments, true);
  assert.deepEqual(spawnable('claude', args, { platform: 'linux', env: { PATH: dir } }), { cmd: 'claude', args, opts: {} });
  fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  assert.deepEqual(spawnable('claude', args, { platform: 'win32', env: winEnv(dir) }), { cmd: path.join(dir, 'claude.exe'), args, opts: {} });
  // node_modules/.bin shims are parsed by cmd twice
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'w.cmd'), '');
  assert.match(spawnable('w', ['a b'], { platform: 'win32', env: winEnv(bin) }).args[3], /\^\^\^"a\^\^\^ b\^\^\^"/);
});
