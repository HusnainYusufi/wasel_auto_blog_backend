export const PIPELINE_STEPS = [
  { key: 'blueprint', label: 'Designing the blueprint', from: 4, to: 24 },
  { key: 'writing', label: 'Writing the article', from: 24, to: 56 },
  { key: 'images', label: 'Art-directing the visuals', from: 56, to: 84 },
  { key: 'seo', label: 'Running the SEO audit', from: 84, to: 94 },
  { key: 'assemble', label: 'Assembling the final post', from: 94, to: 100 },
] as const;

export type PipelineStepKey = (typeof PIPELINE_STEPS)[number]['key'];

export interface ProgressEvent {
  blogId: string;
  step: PipelineStepKey | 'done' | 'failed';
  status: 'running' | 'done' | 'failed';
  message: string;
  progress: number;
  createdAt: string;
}
