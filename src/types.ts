// Shapes of schema/video.schema.json and brand/tokens.json. The JSON Schema is the source of truth.

export type BeatRole = 'hook' | 'context' | 'body' | 'payoff' | 'tease' | 'cta';

export type Visual =
  | { type: 'solid'; color?: string }
  | { type: 'typography'; text: string; style?: 'statement' | 'number'; color?: string }
  | { type: 'still'; asset: string; motion?: 'static' | 'push_in' | 'pull_out' | 'pan_left' | 'pan_right' }
  | { type: 'clip'; asset: string; trim_start_sec?: number; playback_rate?: number };

export interface Overlay {
  text: string;
  style?: 'hook_slam' | 'card' | 'kicker';
  position?: 'upper' | 'center';
}

export interface Beat {
  id: string;
  role: BeatRole;
  vo: string;
  visual: Visual;
  overlay?: Overlay;
  /** When true, no caption page is shown while this beat is on screen; the VO still plays (SPEC section 7). */
  captions_hidden?: boolean;
  /** Free-text note on what this beat's visual should show. Ignored by the renderer; input for M5b asset search. */
  visual_intent?: string;
  /** Camera/effects preset for this beat (overrides the spec's `motion_preset`). Applies to stills and number cards. */
  motion?: MotionPresetName;
  /** Stock search terms for M5b `studio assets`. Ignored by the renderer. */
  search_queries?: string[];
  /** Generated-images mode: what the image shows. Input for `studio prompts`; ignored by the renderer. */
  image_prompt?: string;
}

export interface CtaPop {
  text: string;
  start: { at_sec: number } | { beat_id: string; phrase: string };
  duration_sec?: number;
  style?: 'pill' | 'bar';
}

export interface VideoSpec {
  id: string;
  version: 1;
  /** `generated`: images come from `studio prompts` / `studio ingest` instead of stock search. */
  image_mode?: 'generated';
  /** Default `motion` preset for every beat. Absent = the plain Ken Burns behavior. */
  motion_preset?: MotionPresetName;
  title?: string;
  series?: { name: string; part: number; total: number; label?: string };
  voice?: { preset?: string; speed?: number };
  beats: Beat[];
  cta_pop?: CtaPop;
  captions?: { enabled?: boolean; style?: 'word_highlight' | 'phrase' };
  end_card?: { enabled?: boolean; text?: string; duration_sec?: number };
  music?: { file: string; gain_db?: number; duck_under_vo?: boolean; license_note: string };
  disclosure?: { ai_generated_label?: boolean };
  meta?: Record<string, unknown>;
}

export interface FontToken {
  family: string;
  file: string;
  weight?: number;
  license: string;
}

export type MotionPresetName = 'calm' | 'drift' | 'punch';

export interface MotionPreset {
  /** Eased push-in over the beat, as a fraction of the starting scale (0.16 = 16%). */
  push: number;
  ease: string;
  drift: { x_px: number; y_px: number; period_sec: number };
  /** Hard cut to a tighter crop of the same image on a still longer than `min_beat_sec`. */
  punch_in: { min_beat_sec: number; scale: number } | null;
  /** Brightness swings +/- `amount` around 1 every `period_sec`. */
  glow_pulse: { amount: number; period_sec: number } | null;
  particles: {
    count: number;
    /** Peak opacity of one ember. */
    opacity: number;
    size_px: [number, number];
    speed_px_s: [number, number];
    /** Fraction of the opacity left behind the label, overlay and captions. */
    caption_opacity: number;
  } | null;
  number_card: { slam_from: number; slam_sec: number; pulse: number; pulse_sec: number; dim_prev: number } | null;
}

export interface Tokens {
  canvas: { width: number; height: number; fps: number };
  safe_zone: { top: number; bottom: number; left: number; right: number };
  colors: Record<string, string>;
  fonts: { display: FontToken; body: FontToken };
  type_scale: {
    hook_slam: number;
    typography_statement: number;
    typography_number: number;
    card: number;
    kicker: number;
    caption: number;
    label: number;
    cta: number;
  };
  line_height: { display: number; body: number };
  /** [vertical, horizontal] px */
  padding: { card: [number, number]; pill: [number, number] };
  radius: { card: number; pill: number };
  caption: { max_lines: number; max_chars_per_line: number; center_y: number };
  motion: {
    still_zoom: [number, number];
    still_pan_px: number;
    cut: string;
    overlay_in_ms: number;
    cta_in_ms: number;
  };
  motion_presets: Record<MotionPresetName, MotionPreset>;
  grade: {
    vignette: number;
    /** Text-darkening alpha over an already-dark background (the floor). */
    darken_behind_text: number;
    /** Text-darkening alpha over a bright background (the ceiling). */
    darken_behind_text_max: number;
    /** Average luma (0-1) at or above which the ceiling applies; the alpha ramps linearly from the floor at 0. */
    darken_bright_luma: number;
    /** How far a text-darkening band fades out above and below the text it sits behind. */
    darken_feather_px: number;
  };
  audio: {
    target_lufs: number;
    true_peak_db: number;
    tail_sec: number;
    /** How far the music bed drops below its `gain_db` while the VO speaks (negative dB). */
    music_duck_db: number;
    music_duck_attack_sec: number;
    music_duck_release_sec: number;
  };
}

export interface Issue {
  level: 'error' | 'warning';
  /** JSON pointer into the spec, e.g. /beats/2/id. Empty for batch-level issues. */
  path: string;
  message: string;
}
