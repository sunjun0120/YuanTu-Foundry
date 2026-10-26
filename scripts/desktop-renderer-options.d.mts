import type { BuildOptions } from 'esbuild';

export declare const RENDERER_ENTRY: string;
export declare const RENDERER_OUTFILE: string;
export declare function rendererBuildOptions(overrides?: BuildOptions): BuildOptions;
