import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const mood = new URL(req.url).searchParams.get('mood');
  try {
    const tracks = await db.getMusicTracks();
    const filtered = mood ? tracks.filter((t) => t.moods.includes(mood)) : tracks;
    return NextResponse.json({ tracks: filtered });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}
