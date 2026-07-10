import { VOICES } from '@scriptreel/core';
import { NextResponse } from 'next/server';

// The canonical Kokoro voice list (doc 10), grouped client-side by language.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ voices: VOICES });
}
