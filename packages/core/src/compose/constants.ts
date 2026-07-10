// FFmpeg composition constants (doc 13). The spec lives here so the worker's
// filtergraphs read tokens, never magic numbers (invariant 10).

export const NORMALIZE_BITRATE = '14M'; // Pass A per-beat clips (doc 13)
export const VIDEO_CODEC_HW = 'h264_videotoolbox'; // Apple Silicon HW encoder
export const KENBURNS_PRESCALE = 2; // pre-scale to 2× target before zoompan (anti-jitter)
export const LOOP_MAX = 3; // loop a short source at most 3×, else hold the last frame
export const NORMALIZE_FILTER_TAIL = 'fps=30,setsar=1,format=yuv420p'; // uniform clip format
