'use client';

import { useQuery } from '@tanstack/react-query';
import { getJson } from '../lib/api';

export interface StageRun {
  stage: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  progress: number;
  detail?: string | null;
}
export interface Render {
  id: string;
  preset: string;
  aspect: string;
  path: string;
  thumbnail_path: string | null;
  duration: number | null;
  bytes: number | null;
  created_at: string;
}
export interface ProjectDetail {
  project: {
    id: string;
    title: string;
    status: string;
    script: string;
    settings: Record<string, unknown>;
    error: { code?: string; stage?: string; message?: string } | null;
  };
  runs: StageRun[];
  overall: number;
  renders: Render[];
}

const ACTIVE = new Set(['queued', 'running']);

// Server-driven: polls fast (< 1 s) only while the run is active, otherwise idle
// (refresh-safe — all state lives on the server).
export function useProject(id: string) {
  return useQuery<ProjectDetail>({
    queryKey: ['project', id],
    queryFn: () => getJson(`/api/projects/${id}`),
    refetchInterval: (q) => (ACTIVE.has(q.state.data?.project?.status ?? '') ? 800 : false),
  });
}
