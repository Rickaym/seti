import { extensionOf, kindByName, type FileEntryType } from '@seti/shared'
import {
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Folder,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'ipynb',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'html',
  'htm',
  'css',
  'scss',
  'xml',
  'vue',
  'svelte',
  'lua',
  'tf',
])

const PROSE = new Set(['md', 'markdown', 'mdx', 'txt', 'log', 'rst', 'adoc', 'mmd', 'mermaid'])

type FileLook = 'folder' | 'code' | 'text' | 'image' | 'sheet' | 'pdf' | 'audio' | 'video' | 'diagram' | 'other'

export const FILE_ICONS: Record<FileLook, LucideIcon> = {
  folder: Folder,
  code: FileCode,
  text: FileText,
  image: FileImage,
  sheet: FileSpreadsheet,
  pdf: FileType,
  audio: FileAudio,
  video: FileVideo,
  diagram: Workflow,
  other: File,
}

const LOOK_OF_KIND: Partial<Record<string, FileLook>> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  csv: 'sheet',
  spreadsheet: 'sheet',
  mermaid: 'diagram',
  pdf: 'pdf',
}

/** Code and plain text, whose first lines say what the file is. */
export const isReadable = (name: string) => CODE.has(extensionOf(name)) || PROSE.has(extensionOf(name))

/** Which icon in FILE_ICONS a file or folder gets, by what its name says it holds. */
export function fileLook(name: string, type: FileEntryType): FileLook {
  if (type === 'dir') {
    return 'folder'
  }
  if (CODE.has(extensionOf(name))) {
    return 'code'
  }
  const byKind = LOOK_OF_KIND[kindByName(name) ?? '']
  if (byKind !== undefined) {
    return byKind
  }
  return PROSE.has(extensionOf(name)) ? 'text' : 'other'
}
