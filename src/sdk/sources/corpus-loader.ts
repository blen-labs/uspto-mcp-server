import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CorpusEntry } from '../../search/corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type SourceCorpus = { endpoints: CorpusEntry[]; fields: CorpusEntry[] };

// The corpus files are static; parse each once. Source factories run more than once
// (buildSupervisor builds sources twice, and account mode builds keyed sources per account key).
const cache = new Map<string, SourceCorpus>();

export function loadSourceCorpus(name: string): SourceCorpus {
  let corpus = cache.get(name);
  if (!corpus) {
    const path = resolve(__dirname, `../../../schema/${name}.json`);
    corpus = JSON.parse(readFileSync(path, 'utf8')) as SourceCorpus;
    cache.set(name, corpus);
  }
  return corpus;
}
