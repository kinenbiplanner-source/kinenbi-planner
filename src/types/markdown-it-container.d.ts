/**
 * markdown-it-container は型定義を同梱していない。
 * DefinitelyTyped 版（@types/markdown-it-container）は markdown-it v14 系の
 * namespace スタイルの型に依存していて、自前の型を持つ markdown-it v15 と噛み合わないため、
 * 使う分だけをここで宣言する。
 */
declare module 'markdown-it-container' {
  import type { MarkdownIt, RendererRule } from 'markdown-it';

  interface ContainerOpts {
    marker?: string;
    validate?(params: string): boolean;
    render?: RendererRule;
  }

  const container: (md: MarkdownIt, name: string, opts?: ContainerOpts) => void;
  export default container;
}
