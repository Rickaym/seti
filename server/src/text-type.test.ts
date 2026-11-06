import { detectTextType, lineCount, pasteGoesToFile, PASTE_FILE_CHARS, PASTE_FILE_LINES } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const lines = (...rows: string[]) => rows.join('\n')

const SAMPLES: [string, string, string][] = [
  ['json', 'JSON', JSON.stringify({ users: [{ id: 1, name: 'Ada' }], total: 1 }, null, 2)],
  ['json', 'JSON', '[1, 2, 3]'],
  ['jsonl', 'JSON Lines', lines('{"level":"info","msg":"start"}', '{"level":"warn","msg":"slow"}', '{"level":"info"}')],
  [
    'yaml',
    'YAML',
    lines(
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: web',
      'spec:',
      '  replicas: 2',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: web',
      '          image: nginx:1.27',
    ),
  ],
  ['toml', 'TOML', lines('[package]', 'name = "seti"', 'version = "0.1.0"', '', '[dependencies]', 'zod = "4"')],
  ['xml', 'XML', lines('<?xml version="1.0"?>', '<note>', '  <to>Ada</to>', '</note>')],
  ['html', 'HTML', lines('<!DOCTYPE html>', '<html>', '<body><p>Hi</p></body>', '</html>')],
  ['svg', 'SVG', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'],
  [
    'csv',
    'CSV',
    lines('id,name,email', '1,Ada,ada@example.com', '2,"Lovelace, A",al@example.com', '3,Bob,bob@example.com'),
  ],
  ['tsv', 'TSV', lines('id\tname\tteam', '1\tAda\tcore', '2\tBob\tops', '3\tCyd\tcore')],
  [
    'md',
    'Markdown',
    lines('# Release notes', '', '- Faster starts', '- Smaller images', '', 'See [the docs](https://example.com).'),
  ],
  [
    'diff',
    'Diff',
    lines(
      'diff --git a/app.ts b/app.ts',
      'index 1111111..2222222 100644',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,3 +1,3 @@',
      '-const a = 1',
      '+const a = 2',
    ),
  ],
  ['diff', 'Diff', lines('--- old.txt', '+++ new.txt', '@@ -1 +1 @@', '-before', '+after')],
  [
    'py',
    'Python',
    lines(
      'import os',
      'from pathlib import Path',
      '',
      'class Loader:',
      '    def load(self, name: str) -> str:',
      '        return Path(name).read_text()',
      '',
      "if __name__ == '__main__':",
      "    print(Loader().load('a'))",
    ),
  ],
  [
    'ts',
    'TypeScript',
    lines(
      "import type { Task } from './task'",
      '',
      'export interface Runner {',
      '  run(task: Task): Promise<void>',
      '}',
      'export const limit: number = 4',
      'function name(task: Task): string {',
      '  return task.title',
      '}',
    ),
  ],
  [
    'js',
    'JavaScript',
    lines(
      "const fs = require('fs')",
      'function read(name) {',
      "  return fs.readFileSync(name, 'utf8')",
      '}',
      'module.exports = { read }',
      'console.log(read(process.argv[2]))',
    ),
  ],
  [
    'go',
    'Go',
    lines(
      'package main',
      '',
      'import (',
      '\t"fmt"',
      ')',
      '',
      'func main() {',
      '\tname := "Ada"',
      '\tfmt.Println(name)',
      '}',
    ),
  ],
  [
    'rs',
    'Rust',
    lines(
      'use std::collections::HashMap;',
      '',
      '#[derive(Debug)]',
      'struct Task { id: u32 }',
      '',
      'fn main() {',
      '    let mut tasks = HashMap::new();',
      '    tasks.insert(1, Task { id: 1 });',
      '    println!("{:?}", tasks);',
      '}',
    ),
  ],
  [
    'java',
    'Java',
    lines(
      'package com.example;',
      '',
      'import java.util.List;',
      '',
      'public class App {',
      '    public static void main(String[] args) {',
      '        System.out.println("hi");',
      '    }',
      '}',
    ),
  ],
  [
    'kt',
    'Kotlin',
    lines(
      'package com.example',
      '',
      'import kotlin.math.max',
      '',
      'data class Task(val id: Int)',
      '',
      'fun main() {',
      '    val task = Task(1)',
      '    println(max(task.id, 2))',
      '}',
    ),
  ],
  [
    'c',
    'C',
    lines(
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '',
      'int main(void) {',
      '    char *name = malloc(8);',
      '    printf("%s", name);',
      '    free(name);',
      '}',
    ),
  ],
  [
    'cpp',
    'C++',
    lines(
      '#include <iostream>',
      '#include <vector>',
      '',
      'int main() {',
      '    std::vector<int> values{1, 2};',
      '    std::cout << values.size();',
      '}',
    ),
  ],
  [
    'sql',
    'SQL',
    lines(
      'SELECT t.id, t.title',
      'FROM task t',
      'WHERE t.status = $1',
      'ORDER BY t.updated_at DESC;',
      'CREATE TABLE note (id serial);',
    ),
  ],
  ['sh', 'Shell', lines('#!/usr/bin/env bash', 'set -euo pipefail', 'echo hi')],
  [
    'sh',
    'Shell',
    lines('cd ~/seti', 'export NODE_ENV=production', 'pnpm install', 'git pull --rebase', 'docker compose up -d'),
  ],
  ['py', 'Python', lines('#!/usr/bin/env python3', 'print(1)')],
  [
    'dockerfile',
    'Dockerfile',
    lines('# build', 'FROM node:24-slim', 'WORKDIR /app', 'COPY . .', 'RUN pnpm install', 'CMD ["node", "index.js"]'),
  ],
  [
    'log',
    'Log',
    lines(
      '2026-10-01T12:00:00Z INFO server started',
      '2026-10-01T12:00:01Z WARN slow query',
      '2026-10-01T12:00:02Z ERROR lost connection',
    ),
  ],
  [
    'log',
    'Log',
    lines(
      'Traceback (most recent call last):',
      '  File "app.py", line 3, in <module>',
      '    main()',
      '  File "app.py", line 2, in main',
      'ZeroDivisionError: division by zero',
    ),
  ],
  [
    'log',
    'Log',
    lines(
      'Exception in thread "main" java.lang.NullPointerException',
      '    at com.example.App.run(App.java:12)',
      '    at com.example.App.main(App.java:5)',
    ),
  ],
]

describe('detectTextType', () => {
  it.each(SAMPLES)('reads %s from a sample', (ext, label, text) => {
    expect(detectTextType(text)).toEqual({ ext, label })
  })

  it('falls back to plain text for prose and anything ambiguous', () => {
    const prose = lines(
      'Hi team,',
      '',
      'The deploy went out this morning, and the dashboards look healthy.',
      'Please flag anything odd before Friday.',
    )
    expect(detectTextType(prose)).toEqual({ ext: 'txt', label: 'Text' })
    expect(detectTextType('')).toEqual({ ext: 'txt', label: 'Text' })
    expect(detectTextType('{ not json')).toEqual({ ext: 'txt', label: 'Text' })
    expect(detectTextType(lines('if x:', '    y'))).toEqual({ ext: 'txt', label: 'Text' })
    expect(detectTextType(lines('one, two', 'three'))).toEqual({ ext: 'txt', label: 'Text' })
  })

  it('keeps Markdown with code fences as Markdown', () => {
    const doc = lines('## Setup', '', '```python', 'import os', 'def main():', '    pass', '```', '', '- step one')
    expect(detectTextType(doc).ext).toBe('md')
  })
})

describe('paste threshold', () => {
  it('turns pastes over about 1k tokens or of 30 lines into files', () => {
    expect(pasteGoesToFile('x'.repeat(PASTE_FILE_CHARS))).toBe(false)
    expect(pasteGoesToFile('x'.repeat(PASTE_FILE_CHARS + 1))).toBe(true)
    expect(pasteGoesToFile(Array.from({ length: PASTE_FILE_LINES - 1 }, () => 'a').join('\n'))).toBe(false)
    expect(pasteGoesToFile(Array.from({ length: PASTE_FILE_LINES }, () => 'a').join('\n'))).toBe(true)
  })

  it('counts lines as an editor does', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\n\nb')).toBe(3)
  })
})
