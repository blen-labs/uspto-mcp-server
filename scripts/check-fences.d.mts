export interface FencedBlock {
  line: number;
  info: string;
  body: string;
}
export declare function fencedBlocks(markdown: string): FencedBlock[];
export declare function unlabelledFences(markdown: string): number[];
export declare function trackedMarkdown(): string[];
