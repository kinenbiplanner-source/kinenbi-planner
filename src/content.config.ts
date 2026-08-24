import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * メディア記事のコレクション。
 *
 * frontmatter の `axis`（コンテンツ軸）と `funnel`（ファネル層）は
 * `.claude/agents/reference/content-axis.md` の定義に合わせている。
 * 記事1本＝「どの軸 × どのファネル層」で位置づける、というSSOTをスキーマで強制する。
 */
const media = defineCollection({
  loader: glob({ base: './src/content/media', pattern: '**/*.md' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      // 軸（content-axis.md の軸一覧と対応）
      axis: z.enum(['ギフト・サプライズ', 'デート・レストラン', '代行サービス']),
      // ファネル層（受け皿＝フォームはCV着地点なのでここには含めない）
      funnel: z.enum(['集客', '比較・検討', '課題解決']),
      publishDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      heroImage: z.optional(image()),
      // 記事末尾に無料相談CTAを出すか（content-axis.md 軸3では必須）
      cta: z.boolean().default(false),
      draft: z.boolean().default(false),
    }),
});

export const collections = { media };
