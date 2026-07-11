import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Beats + their top-8 candidates for the storyboard (doc 15). Thumb paths are
// returned raw; the client maps them through /api/files via fileUrl().
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await db.getProject(id);
    if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // Postgres numeric columns (score, duration) arrive as strings via postgres.js —
    // coerce to numbers so the client can do math / toFixed on them.
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    const storyboard = await db.getStoryboard(id);
    const beats = storyboard.map(({ beat, candidates }) => {
      const chosen = candidates.find((c) => c.id === beat.chosen_candidate_id);
      return {
        id: beat.id,
        idx: beat.idx,
        text: beat.text,
        emotion: beat.emotion,
        estSeconds: num(beat.est_seconds),
        visualDescription: beat.visual_description,
        forcedTextcard: beat.forced_textcard,
        chosenCandidateId: beat.chosen_candidate_id,
        score: num(chosen?.score),
        candidates: candidates.map((c) => ({
          id: c.id,
          kind: c.kind,
          provider: c.provider,
          thumbPath: c.thumb_path,
          remoteUrl: c.remote_url, // direct media file — lets the storyboard preview video
          duration: num(c.duration),
          author: c.author,
          score: num(c.score),
          pageUrl: c.page_url,
          width: c.width,
          height: c.height,
        })),
      };
    });
    return NextResponse.json({ beats });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}
