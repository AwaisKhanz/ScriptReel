-- 0002_seed_music.sql — seed music_tracks from assets/music/manifest.json (doc 05 §Seed).
-- CC0 / public-domain library (FreePD.com). Idempotent via ON CONFLICT so re-pushes
-- and re-seeds are safe. Audio files (assets/music/<id>.mp3) are committed separately.

insert into music_tracks (id, title, moods, bpm, duration, path, license, credit) values
  ('wholesome',        'Wholesome',          array['uplifting','energetic'], 120, 138, 'assets/music/wholesome.mp3',        'CC0', 'FreePD.com (CC0)'),
  ('beauty-flow',      'Beauty Flow',        array['calm','emotional'],       90, 145, 'assets/music/beauty-flow.mp3',      'CC0', 'FreePD.com (CC0)'),
  ('city-sunshine',    'City Sunshine',      array['uplifting','corporate'], 110, 132, 'assets/music/city-sunshine.mp3',    'CC0', 'FreePD.com (CC0)'),
  ('chill-wave',       'Chill Wave',         array['calm'],                   85, 160, 'assets/music/chill-wave.mp3',       'CC0', 'FreePD.com (CC0)'),
  ('rhythm',           'Rhythm',             array['energetic'],             128, 150, 'assets/music/rhythm.mp3',           'CC0', 'FreePD.com (CC0)'),
  ('serenity',         'Serenity',           array['calm','emotional'],       70, 175, 'assets/music/serenity.mp3',         'CC0', 'FreePD.com (CC0)'),
  ('the-return',       'The Return',         array['tense','emotional'],      95, 168, 'assets/music/the-return.mp3',       'CC0', 'FreePD.com (CC0)'),
  ('vibe-ace',         'Vibe Ace',           array['uplifting','energetic'], 122, 140, 'assets/music/vibe-ace.mp3',         'CC0', 'FreePD.com (CC0)'),
  ('dreamer',          'Dreamer',            array['calm','uplifting'],      100, 155, 'assets/music/dreamer.mp3',          'CC0', 'FreePD.com (CC0)'),
  ('reformat',         'Reformat',           array['corporate','energetic'], 118, 142, 'assets/music/reformat.mp3',         'CC0', 'FreePD.com (CC0)'),
  ('feelin-good',      'Feelin Good',        array['uplifting'],             115, 130, 'assets/music/feelin-good.mp3',      'CC0', 'FreePD.com (CC0)'),
  ('bathed-in-light',  'Bathed in the Light', array['emotional','calm'],      80, 180, 'assets/music/bathed-in-light.mp3',  'CC0', 'FreePD.com (CC0)'),
  ('midnight-tension', 'Midnight Tension',   array['tense'],                 100, 165, 'assets/music/midnight-tension.mp3', 'CC0', 'FreePD.com (CC0)'),
  ('corporate-uplift', 'Corporate Uplift',   array['corporate','uplifting'], 112, 128, 'assets/music/corporate-uplift.mp3', 'CC0', 'FreePD.com (CC0)')
on conflict (id) do update set
  title = excluded.title, moods = excluded.moods, bpm = excluded.bpm,
  duration = excluded.duration, path = excluded.path,
  license = excluded.license, credit = excluded.credit;
