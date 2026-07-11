-- 0003_realmusic.sql — replace the placeholder FreePD seed (0002) with the real
-- CC BY 4.0 library by Kevin MacLeod (incompetech.com). FreePD.com (the original
-- CC0 mirror) closed in 2025, so 6 fictional placeholder tracks are dropped and the
-- catalog is reconciled to 14 real, downloadable tracks. Files: scripts/fetch_music.py.
-- Idempotent: delete-all then insert (re-runs converge to the same 14 rows).

delete from music_tracks;

insert into music_tracks (id, title, moods, bpm, duration, path, license, credit) values
  ('wholesome',          'Wholesome',           array['uplifting','energetic'], 120, 364, 'assets/music/wholesome.mp3',          'CC BY 4.0', '"Wholesome" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('beauty-flow',        'Beauty Flow',         array['calm','emotional'],       90, 433, 'assets/music/beauty-flow.mp3',        'CC BY 4.0', '"Beauty Flow" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('chill-wave',         'Chill Wave',          array['calm'],                   85, 240, 'assets/music/chill-wave.mp3',         'CC BY 4.0', '"Chill Wave" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('vibe-ace',           'Vibe Ace',            array['uplifting','energetic'], 122,  61, 'assets/music/vibe-ace.mp3',           'CC BY 4.0', '"Vibe Ace" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('dreamer',            'Dreamer',             array['calm','uplifting'],      100, 204, 'assets/music/dreamer.mp3',            'CC BY 4.0', '"Dreamer" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('reformat',           'Reformat',            array['corporate','energetic'], 118, 219, 'assets/music/reformat.mp3',           'CC BY 4.0', '"Reformat" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('feelin-good',        'Feelin Good',         array['uplifting'],             115, 225, 'assets/music/feelin-good.mp3',        'CC BY 4.0', '"Feelin Good" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('bathed-in-light',    'Bathed in the Light', array['emotional','calm'],       80, 166, 'assets/music/bathed-in-light.mp3',    'CC BY 4.0', '"Bathed in the Light" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('blippy-trance',      'Blippy Trance',       array['energetic'],             128, 120, 'assets/music/blippy-trance.mp3',      'CC BY 4.0', '"Blippy Trance" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('anguish',            'Anguish',             array['emotional'],              70, 239, 'assets/music/anguish.mp3',            'CC BY 4.0', '"Anguish" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('darkling',           'Darkling',            array['tense','emotional'],      95, 170, 'assets/music/darkling.mp3',           'CC BY 4.0', '"Darkling" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('anxiety',            'Anxiety',             array['tense'],                 100, 111, 'assets/music/anxiety.mp3',            'CC BY 4.0', '"Anxiety" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('inspired',           'Inspired',            array['corporate','uplifting'], 112, 286, 'assets/music/inspired.mp3',           'CC BY 4.0', '"Inspired" by Kevin MacLeod (incompetech.com) — CC BY 4.0'),
  ('deliberate-thought', 'Deliberate Thought',  array['corporate','calm'],      100, 177, 'assets/music/deliberate-thought.mp3', 'CC BY 4.0', '"Deliberate Thought" by Kevin MacLeod (incompetech.com) — CC BY 4.0')
on conflict (id) do update set
  title = excluded.title, moods = excluded.moods, bpm = excluded.bpm,
  duration = excluded.duration, path = excluded.path,
  license = excluded.license, credit = excluded.credit;
